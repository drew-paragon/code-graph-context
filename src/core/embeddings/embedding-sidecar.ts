/**
 * Embedding Sidecar Manager
 * Manages a Python FastAPI process that serves local embedding requests.
 * The sidecar loads the model once and keeps it warm between requests.
 */

import { spawn, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface SidecarConfig {
  port: number;
  host: string;
  model: string;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  idleTimeoutMs: number;
}

const DEFAULT_CONFIG: SidecarConfig = {
  port: parseInt(process.env.EMBEDDING_SIDECAR_PORT ?? '', 10) || 8787,
  host: '127.0.0.1',
  model: process.env.EMBEDDING_MODEL ?? 'codesage/codesage-base-v2',
  startupTimeoutMs: 120_000, // 2 min — first run downloads the model
  requestTimeoutMs: 60_000,
  idleTimeoutMs: 180_000, // 3 min — auto-shutdown after no requests
};

export class EmbeddingSidecar {
  private process: ChildProcess | null = null;
  private readyPromise: Promise<void> | null = null;
  private config: SidecarConfig;
  private _dimensions: number | null = null;
  private stopping = false;
  private _exitHandler: (() => void) | null = null;
  private _idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: Partial<SidecarConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  get baseUrl(): string {
    return `http://${this.config.host}:${this.config.port}`;
  }

  get dimensions(): number | null {
    return this._dimensions;
  }

  get isRunning(): boolean {
    return this.process !== null && !this.stopping;
  }

  /**
   * Start the sidecar process. No-ops if already running.
   * Resolves when the server is healthy and ready to serve requests.
   */
  async start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;

    this.stopping = false;
    this.readyPromise = this.doStart();

    try {
      await this.readyPromise;
    } catch (err) {
      // Clean up on failed start
      this.cleanup();
      throw err;
    }
  }

  /**
   * Resolve the python binary — prefer venv, fall back to system python3.
   */
  private resolvePython(sidecarDir: string): string {
    const venvPython = join(sidecarDir, '.venv', 'bin', 'python3');
    if (existsSync(venvPython)) return venvPython;
    return 'python3';
  }

  private async doStart(): Promise<void> {
    // Check if something is already listening on the port (e.g. previous run)
    if (await this.checkHealth()) {
      console.error(`[embedding-sidecar] Server already running on ${this.baseUrl}`);
      return;
    }

    await this.verifyPython();

    // sidecar/ lives at project root — go up from dist/core/embeddings/ or src/core/embeddings/
    const sidecarDir = join(__dirname, '..', '..', '..', 'sidecar');
    const python = this.resolvePython(sidecarDir);

    console.error(`[embedding-sidecar] Starting on ${this.baseUrl} (python: ${python}, model: ${this.config.model})`);

    this.process = spawn(
      python,
      ['-m', 'uvicorn', 'embedding_server:app', '--host', this.config.host, '--port', String(this.config.port)],
      {
        cwd: sidecarDir,
        // stdin='pipe' so the child detects parent death when the pipe breaks
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          EMBEDDING_MODEL: this.config.model,
        },
      },
    );

    // Store pid for synchronous cleanup on exit
    const childPid = this.process.pid;

    // Forward stderr for visibility (model loading progress, errors)
    this.process.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) console.error(`[embedding-sidecar] ${line}`);
    });

    this.process.on('error', (err) => {
      console.error(`[embedding-sidecar] Process error: ${err.message}`);
    });

    this.process.on('exit', (code, signal) => {
      if (!this.stopping) {
        console.error(`[embedding-sidecar] Process exited unexpectedly (code=${code}, signal=${signal})`);
      }
      this.cleanup();
    });

    // Synchronous kill on parent exit — this is the only guaranteed cleanup
    // when the Node process dies unexpectedly (SIGKILL, crash, etc.)
    if (childPid) {
      const exitHandler = (): void => {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          // Process already dead — ignore
        }
      };
      process.on('exit', exitHandler);
      // Store handler so we can remove it when the sidecar stops normally
      this._exitHandler = exitHandler;
    }

    // Poll until healthy
    await this.waitForHealthy();
  }

  private async verifyPython(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const check = spawn('python3', ['--version'], { stdio: 'pipe' });
      let output = '';
      check.stdout?.on('data', (d: Buffer) => (output += d.toString()));
      check.stderr?.on('data', (d: Buffer) => (output += d.toString()));
      check.on('error', () => {
        reject(
          new Error(
            'python3 not found. Local embeddings require Python 3.10+.\n\n' +
              'Install Python and the sidecar dependencies:\n' +
              '  pip install -r sidecar/requirements.txt\n\n' +
              'Or set OPENAI_ENABLED=true to use OpenAI instead.',
          ),
        );
      });
      check.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`python3 check failed: ${output}`));
        } else {
          resolve();
        }
      });
    });
  }

  private async waitForHealthy(): Promise<void> {
    const start = Date.now();
    const pollInterval = 1000;

    while (Date.now() - start < this.config.startupTimeoutMs) {
      if (this.stopping) throw new Error('Sidecar stopped during startup');
      if (this.process?.exitCode !== null && this.process?.exitCode !== undefined) {
        throw new Error(`Sidecar process exited during startup with code ${this.process.exitCode}`);
      }

      if (await this.checkHealth()) {
        console.error(`[embedding-sidecar] Ready (${Date.now() - start}ms)`);
        return;
      }

      await new Promise((r) => setTimeout(r, pollInterval));
    }

    throw new Error(
      `Embedding sidecar failed to start within ${this.config.startupTimeoutMs}ms.\n` +
        'This usually means the model is still downloading or dependencies are missing.\n\n' +
        'Try running manually:\n' +
        '  cd sidecar && python3 -m uvicorn embedding_server:app --host 127.0.0.1 --port 8787',
    );
  }

  private async checkHealth(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);

      const res = await fetch(`${this.baseUrl}/health`, { signal: controller.signal });
      clearTimeout(timeout);

      if (res.ok) {
        const data = (await res.json()) as { status: string; dimensions?: number; model?: string };
        if (data.dimensions) this._dimensions = data.dimensions;
        return data.status === 'ok';
      }
      return false;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[embedding-sidecar] Health check failed: ${msg}`);
      return false;
    }
  }

  /**
   * Embed an array of texts. Lazily starts the sidecar if not running.
   */
  async embed(texts: string[]): Promise<number[][]> {
    await this.start();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    const startTime = Date.now();

    try {
      const res = await fetch(`${this.baseUrl}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const detail = await res.text();
        const isOOM = detail.toLowerCase().includes('out of memory');

        if (res.status === 500 && isOOM) {
          // OOM leaves GPU memory in a corrupted state — kill the sidecar
          // so the next request spawns a fresh process with clean memory
          console.error('[embedding-sidecar] OOM detected, restarting sidecar to reclaim GPU memory');
          await this.stop();
        }

        console.error(`[embedding-sidecar] Embed failed after ${Date.now() - startTime}ms: status=${res.status}, texts=${texts.length}, oom=${isOOM}, detail=${detail}`);
        throw new Error(`Sidecar embed failed (${res.status}): ${detail}`);
      }

      const data = (await res.json()) as { embeddings: number[][]; dimensions: number };
      if (data.dimensions) this._dimensions = data.dimensions;
      console.error(`[embedding-sidecar] Embedded ${texts.length} texts in ${Date.now() - startTime}ms (dims=${data.dimensions})`);
      this.resetIdleTimer();
      return data.embeddings;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        console.error(`[embedding-sidecar] Request timed out after ${Date.now() - startTime}ms (limit=${this.config.requestTimeoutMs}ms, texts=${texts.length}), restarting sidecar`);
        await this.stop();
        throw new Error(`Embedding request timed out after ${this.config.requestTimeoutMs}ms`);
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[embedding-sidecar] Embed error after ${Date.now() - startTime}ms: ${msg} (url=${this.baseUrl}, running=${this.isRunning}, texts=${texts.length})`);
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Embed a single text. Convenience wrapper.
   */
  async embedText(text: string): Promise<number[]> {
    const [embedding] = await this.embed([text]);
    return embedding;
  }

  /**
   * Stop the sidecar process.
   */
  async stop(): Promise<void> {
    this.stopping = true;

    if (this.process) {
      console.error('[embedding-sidecar] Stopping...');
      this.process.kill('SIGTERM');

      // Give it 5s to shut down gracefully, then force kill
      await new Promise<void>((resolve) => {
        const forceKill = setTimeout(() => {
          if (this.process) {
            this.process.kill('SIGKILL');
          }
          resolve();
        }, 5000);

        this.process?.on('exit', () => {
          clearTimeout(forceKill);
          resolve();
        });
      });
    }

    this.cleanup();
  }

  private resetIdleTimer(): void {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => {
      console.error(`[embedding-sidecar] Idle for ${this.config.idleTimeoutMs / 1000}s, shutting down to free memory`);
      this.stop();
    }, this.config.idleTimeoutMs);
    // Don't let the timer prevent Node from exiting
    this._idleTimer.unref();
  }

  private cleanup(): void {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
    if (this._exitHandler) {
      process.removeListener('exit', this._exitHandler);
      this._exitHandler = null;
    }
    this.process = null;
    this.readyPromise = null;
  }
}

/**
 * Singleton sidecar instance — shared across all tool calls.
 * The sidecar starts lazily on first embed request and stays warm.
 */
let sidecarInstance: EmbeddingSidecar | null = null;

export const getEmbeddingSidecar = (): EmbeddingSidecar => {
  sidecarInstance ??= new EmbeddingSidecar();
  return sidecarInstance;
};

export const stopEmbeddingSidecar = async (): Promise<void> => {
  if (sidecarInstance) {
    await sidecarInstance.stop();
    sidecarInstance = null;
  }
};
