#!/usr/bin/env node
/**
 * CLI Entry Point for Code Graph Context
 *
 * Handles CLI commands (init, status, stop) and delegates to MCP server
 */

import { execSync, spawn as spawnProcess } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { Command } from 'commander';

import {
  NEO4J_CONFIG,
  createContainer,
  getContainerStatus,
  getFullStatus,
  isApocAvailable,
  isDockerInstalled,
  isDockerRunning,
  removeContainer,
  startContainer,
  stopContainer,
  waitForNeo4j,
} from './neo4j-docker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ANSI colors
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
} as const;

const sym = {
  ok: `${c.green}✓${c.reset}`,
  err: `${c.red}✗${c.reset}`,
  warn: `${c.yellow}⚠${c.reset}`,
  info: `${c.blue}ℹ${c.reset}`,
} as const;

const log = (symbol: string, msg: string): void => {
  console.log(`  ${symbol} ${msg}`);
};

const header = (text: string): void => {
  console.log(`\n${c.bold}${text}${c.reset}\n`);
};

/**
 * Spinner for async operations
 */
const spinner = (msg: string): { stop: (ok: boolean, finalMsg?: string) => void } => {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const interval = setInterval(() => {
    process.stdout.write(`\r  ${c.blue}${frames[i]}${c.reset} ${msg}`);
    i = (i + 1) % frames.length;
  }, 80);

  return {
    stop: (ok: boolean, finalMsg?: string) => {
      clearInterval(interval);
      process.stdout.write(`\r  ${ok ? sym.ok : sym.err} ${finalMsg ?? msg}\n`);
    },
  };
};

/**
 * Print config instructions
 */
const printConfigInstructions = (password: string, boltPort: number): void => {
  console.log(`
${c.bold}Next steps:${c.reset}

  1. Add to Claude Code:
     ${c.dim}claude mcp add code-graph-context code-graph-context${c.reset}

  2. Configure in ${c.cyan}~/.config/claude/config.json${c.reset}:

     ${c.dim}{
       "mcpServers": {
         "code-graph-context": {
           "command": "code-graph-context",
           "env": {${
             password !== NEO4J_CONFIG.defaultPassword
               ? `
             "NEO4J_PASSWORD": "${password}"${boltPort !== NEO4J_CONFIG.boltPort ? ',' : ''}`
               : ''
           }${
             boltPort !== NEO4J_CONFIG.boltPort
               ? `
             "NEO4J_URI": "bolt://localhost:${boltPort}"`
               : ''
           }
           }
         }
       }
     }${c.reset}

     ${c.dim}Local embeddings are used by default (no API key needed).
     To use OpenAI instead, add:
       "OPENAI_ENABLED": "true",
       "OPENAI_API_KEY": "sk-..."${c.reset}

  3. Restart Claude Code
`);
};

/**
 * Resolve the sidecar directory (works from both src/ and dist/)
 */
const getSidecarDir = (): string => join(__dirname, '..', '..', 'sidecar');

/**
 * Get the path to the venv python binary inside the sidecar dir.
 * Returns null if the venv doesn't exist yet.
 */
const getVenvPython = (sidecarDir: string): string | null => {
  const venvPython = join(sidecarDir, '.venv', 'bin', 'python3');
  return existsSync(venvPython) ? venvPython : null;
};

/**
 * Get the best python binary to use for the sidecar.
 * Prefers venv python, falls back to system python3.
 */
const getSidecarPython = (sidecarDir: string): string => {
  return getVenvPython(sidecarDir) ?? 'python3';
};

/**
 * Check if python3 is available and return its version
 */
const getPythonVersion = (): string | null => {
  try {
    return execSync('python3 --version', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
};

/**
 * Check if a pip package is importable using the sidecar python
 */
const checkPipPackage = (pkg: string, python: string = 'python3'): boolean => {
  try {
    execSync(`${python} -c "import ${pkg}"`, { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
};

/**
 * Create a venv in the sidecar directory
 */
const createVenv = (sidecarDir: string): boolean => {
  try {
    const venvPath = join(sidecarDir, '.venv');
    execSync(`python3 -m venv ${venvPath}`, { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
};

/**
 * Install sidecar Python dependencies via pip inside the venv
 */
const installSidecarDeps = (sidecarDir: string): Promise<boolean> => {
  return new Promise((resolve) => {
    const venvPip = join(sidecarDir, '.venv', 'bin', 'pip');
    const requirementsPath = join(sidecarDir, 'requirements.txt');
    const pip = spawnProcess(venvPip, ['install', '-r', requirementsPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    pip.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line && (line.includes('Downloading') || line.includes('Installing') || line.includes('ERROR'))) {
        process.stdout.write(`\r  ${c.blue}⠸${c.reset} ${line.slice(0, 70).padEnd(70)}`);
      }
    });

    pip.on('close', (code) => {
      process.stdout.write('\r' + ' '.repeat(80) + '\r');
      resolve(code === 0);
    });

    pip.on('error', () => {
      resolve(false);
    });
  });
};

/**
 * Verify sentence-transformers can be imported using the venv python
 */
const verifySidecar = (sidecarDir: string): Promise<boolean> => {
  return new Promise((resolve) => {
    const python = getSidecarPython(sidecarDir);
    const test = spawnProcess(python, ['-c', 'from sentence_transformers import SentenceTransformer; print("ok")'], {
      cwd: sidecarDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    test.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    test.on('close', (code) => resolve(code === 0 && stdout.includes('ok')));
    test.on('error', () => resolve(false));
  });
};

/**
 * Set up the Python embedding sidecar
 */
const setupSidecar = async (): Promise<void> => {
  console.log('');
  header('Embedding Sidecar Setup');

  const sidecarDir = getSidecarDir();

  // Check Python
  const pythonVersion = getPythonVersion();
  if (!pythonVersion) {
    log(sym.err, 'Python 3 is not installed');
    console.log(`\n  Install Python 3.10+: ${c.cyan}https://www.python.org/downloads/${c.reset}`);
    console.log(`  ${c.dim}Or use OpenAI embeddings instead: set OPENAI_ENABLED=true${c.reset}\n`);
    return;
  }
  log(sym.ok, `${pythonVersion}`);

  // Create or reuse venv
  const venvPath = join(sidecarDir, '.venv');
  if (existsSync(venvPath)) {
    log(sym.ok, `Virtual environment exists (${c.dim}sidecar/.venv${c.reset})`);
  } else {
    const venvSpinner = spinner('Creating virtual environment...');
    const created = createVenv(sidecarDir);
    if (!created) {
      venvSpinner.stop(false, 'Failed to create virtual environment');
      console.log(`\n  Try manually: ${c.dim}python3 -m venv ${venvPath}${c.reset}\n`);
      return;
    }
    venvSpinner.stop(true, `Virtual environment created (${c.dim}sidecar/.venv${c.reset})`);
  }

  const python = getSidecarPython(sidecarDir);

  // Check if deps already installed in venv
  const hasSentenceTransformers = checkPipPackage('sentence_transformers', python);
  const hasFastApi = checkPipPackage('fastapi', python);
  const hasTorch = checkPipPackage('torch', python);

  if (hasSentenceTransformers && hasFastApi && hasTorch) {
    log(sym.ok, 'Python dependencies already installed');
  } else {
    const missing: string[] = [];
    if (!hasTorch) missing.push('torch');
    if (!hasSentenceTransformers) missing.push('sentence-transformers');
    if (!hasFastApi) missing.push('fastapi');
    log(sym.info, `Missing packages: ${missing.join(', ')}`);

    const s = spinner('Installing Python dependencies (this may take a few minutes)...');
    const installed = await installSidecarDeps(sidecarDir);
    if (!installed) {
      s.stop(false, 'Failed to install Python dependencies');
      console.log(
        `\n  Try manually: ${c.dim}${join(venvPath, 'bin', 'pip')} install -r ${join(sidecarDir, 'requirements.txt')}${c.reset}\n`,
      );
      return;
    }
    s.stop(true, 'Python dependencies installed');
  }

  // Verify sentence-transformers works
  const verifySpinner = spinner('Verifying sentence-transformers...');
  const verified = await verifySidecar(sidecarDir);
  verifySpinner.stop(verified, verified ? 'sentence-transformers OK' : 'sentence-transformers import failed');

  if (!verified) {
    console.log(`\n  ${c.dim}Try: ${python} -c "from sentence_transformers import SentenceTransformer"${c.reset}`);
    console.log(`  ${c.dim}Or use OpenAI embeddings instead: set OPENAI_ENABLED=true${c.reset}\n`);
    return;
  }

  // Pre-download the embedding model so first real use is fast
  const modelName = process.env.EMBEDDING_MODEL ?? 'Qwen/Qwen3-Embedding-0.6B';
  await preDownloadModel(sidecarDir, python, modelName);
};

/**
 * Pre-download the embedding model during init so the first parse doesn't hang.
 * SentenceTransformer downloads to ~/.cache/huggingface/ on first load.
 */
const preDownloadModel = async (sidecarDir: string, python: string, modelName: string): Promise<void> => {
  // Check if model is already cached by trying a quick load
  const checkCached = (): Promise<boolean> => {
    return new Promise((resolve) => {
      const proc = spawnProcess(
        python,
        [
          '-c',
          `from sentence_transformers import SentenceTransformer; m = SentenceTransformer("${modelName}"); print(f"dims:{len(m.encode(['test'])[0])}")`,
        ],
        { cwd: sidecarDir, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 },
      );

      let stdout = '';
      proc.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
      proc.on('close', (code) => resolve(code === 0 && stdout.includes('dims:')));
      proc.on('error', () => resolve(false));
    });
  };

  // Quick check — if model is cached, this returns in ~5s
  const quickSpinner = spinner(`Checking for cached model (${modelName})...`);
  const isCached = await checkCached();

  if (isCached) {
    quickSpinner.stop(true, `Model ready (${modelName})`);
    return;
  }

  quickSpinner.stop(false, 'Model not cached yet');
  log(sym.info, 'Downloading embedding model (~600MB, only needed once)');

  // Download the model — this can take a few minutes.
  // Pipe stderr directly to the terminal so HuggingFace progress bars render natively.
  const downloaded = await new Promise<boolean>((resolve) => {
    const proc = spawnProcess(
      python,
      [
        '-c',
        `from sentence_transformers import SentenceTransformer; print("downloading..."); m = SentenceTransformer("${modelName}"); print(f"done dims:{len(m.encode(['test'])[0])}")`,
      ],
      { cwd: sidecarDir, stdio: ['pipe', 'pipe', 'inherit'] },
    );

    let stdout = '';
    proc.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.on('close', (code) => {
      resolve(code === 0 && stdout.includes('done'));
    });
    proc.on('error', () => resolve(false));
  });

  if (downloaded) {
    log(sym.ok, 'Embedding model downloaded and cached');
  } else {
    log(sym.warn, 'Model download failed — it will retry on first use');
    console.log(
      `  ${c.dim}You can download manually: ${python} -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('${modelName}')"${c.reset}`,
    );
  }
};

interface InitOptions {
  port?: string;
  httpPort?: string;
  password?: string;
  memory?: string;
  force?: boolean;
}

/**
 * Init command - set up Neo4j
 */
const runInit = async (options: InitOptions): Promise<void> => {
  const boltPort = options.port ? parseInt(options.port, 10) : NEO4J_CONFIG.boltPort;
  const httpPort = options.httpPort ? parseInt(options.httpPort, 10) : NEO4J_CONFIG.httpPort;
  const password = options.password ?? NEO4J_CONFIG.defaultPassword;
  const memory = options.memory ?? '4G';

  header('Code Graph Context Setup');

  // Check Docker
  if (!isDockerInstalled()) {
    log(sym.err, 'Docker is not installed');
    console.log(`\n  Install Docker: ${c.cyan}https://docs.docker.com/get-docker/${c.reset}\n`);
    process.exit(1);
  }
  log(sym.ok, 'Docker installed');

  if (!isDockerRunning()) {
    log(sym.err, 'Docker daemon is not running');
    console.log(`\n  Start Docker Desktop or run: ${c.dim}sudo systemctl start docker${c.reset}\n`);
    process.exit(1);
  }
  log(sym.ok, 'Docker daemon running');

  // Handle existing container
  const status = getContainerStatus();

  if (status === 'running' && !options.force) {
    log(sym.ok, 'Neo4j container already running');

    const apocOk = isApocAvailable(NEO4J_CONFIG.containerName, password);
    log(apocOk ? sym.ok : sym.warn, apocOk ? 'APOC plugin available' : 'APOC plugin not detected');

    console.log(`\n  ${c.dim}Use --force to recreate the container${c.reset}`);

    // Still set up sidecar even if Neo4j is already running
    await setupSidecar();

    printConfigInstructions(password, boltPort);
    return;
  }

  if (status !== 'not-found' && options.force) {
    const s = spinner('Removing existing container...');
    stopContainer();
    removeContainer();
    s.stop(true, 'Removed existing container');
  }

  if (status === 'stopped' && !options.force) {
    const s = spinner('Starting existing container...');
    const started = startContainer();
    if (!started) {
      s.stop(false, 'Failed to start container');
      console.log(`\n  Try: ${c.dim}code-graph-context init --force${c.reset}\n`);
      process.exit(1);
    }
    s.stop(true, 'Container started');
  } else if (status === 'not-found' || options.force) {
    const s = spinner('Creating Neo4j container...');
    const created = createContainer({ httpPort, boltPort, password, memory });
    if (!created) {
      s.stop(false, 'Failed to create container');
      console.log(`
  Check if ports are in use:
    ${c.dim}lsof -i :${httpPort}${c.reset}
    ${c.dim}lsof -i :${boltPort}${c.reset}
`);
      process.exit(1);
    }
    s.stop(true, 'Container created');
  }

  // Wait for Neo4j
  const healthSpinner = spinner('Waiting for Neo4j to be ready (this may take a minute)...');
  const ready = await waitForNeo4j(NEO4J_CONFIG.containerName, password);
  healthSpinner.stop(ready, ready ? 'Neo4j is ready' : 'Neo4j failed to start');

  if (!ready) {
    console.log(`\n  Check logs: ${c.dim}docker logs ${NEO4J_CONFIG.containerName}${c.reset}\n`);
    process.exit(1);
  }

  // Check APOC
  const apocOk = isApocAvailable(NEO4J_CONFIG.containerName, password);
  log(apocOk ? sym.ok : sym.warn, apocOk ? 'APOC plugin verified' : 'APOC still loading (should be ready shortly)');

  // Print connection info
  console.log(`
${c.bold}Neo4j is ready${c.reset}

  Browser:     ${c.cyan}http://localhost:${httpPort}${c.reset}
  Bolt URI:    ${c.cyan}bolt://localhost:${boltPort}${c.reset}
  Credentials: ${c.dim}neo4j / ${password}${c.reset}`);

  // Set up Python embedding sidecar
  await setupSidecar();

  printConfigInstructions(password, boltPort);
};

/**
 * Status command
 */
const runStatus = (): void => {
  header('Code Graph Context Status');

  const status = getFullStatus();

  log(status.dockerInstalled ? sym.ok : sym.err, `Docker installed: ${status.dockerInstalled ? 'yes' : 'no'}`);

  if (!status.dockerInstalled) {
    console.log(`\n  Install: ${c.cyan}https://docs.docker.com/get-docker/${c.reset}\n`);
    return;
  }

  log(status.dockerRunning ? sym.ok : sym.err, `Docker running: ${status.dockerRunning ? 'yes' : 'no'}`);

  if (!status.dockerRunning) {
    console.log(`\n  Start Docker Desktop or: ${c.dim}sudo systemctl start docker${c.reset}\n`);
    return;
  }

  const containerIcon =
    status.containerStatus === 'running' ? sym.ok : status.containerStatus === 'stopped' ? sym.warn : sym.err;
  log(containerIcon, `Container: ${status.containerStatus}`);

  if (status.containerStatus === 'running') {
    log(status.neo4jReady ? sym.ok : sym.warn, `Neo4j responding: ${status.neo4jReady ? 'yes' : 'no'}`);
    log(
      status.apocAvailable ? sym.ok : sym.warn,
      `APOC plugin: ${status.apocAvailable ? 'available' : 'not available'}`,
    );
  }

  // Sidecar status
  console.log('');
  const pythonVersion = getPythonVersion();
  log(pythonVersion ? sym.ok : sym.warn, `Python: ${pythonVersion ?? 'not found'}`);

  if (pythonVersion) {
    const sidecarDir = getSidecarDir();
    const venvExists = existsSync(join(sidecarDir, '.venv'));
    log(venvExists ? sym.ok : sym.warn, `Sidecar venv: ${venvExists ? 'exists' : 'not created'}`);

    if (venvExists) {
      const python = getSidecarPython(sidecarDir);
      const hasDeps =
        checkPipPackage('sentence_transformers', python) &&
        checkPipPackage('fastapi', python) &&
        checkPipPackage('torch', python);
      log(hasDeps ? sym.ok : sym.warn, `Sidecar deps: ${hasDeps ? 'installed' : 'not installed'}`);
    }
  }

  console.log('');

  if (status.containerStatus !== 'running') {
    console.log(`  Run ${c.dim}code-graph-context init${c.reset} to start Neo4j\n`);
  } else if (!status.apocAvailable) {
    console.log(`  APOC may still be loading. Wait a moment and check again.\n`);
  }
};

/**
 * Stop command
 */
const runStop = (): void => {
  const status = getContainerStatus();

  if (status === 'not-found') {
    log(sym.info, 'No Neo4j container found');
    return;
  }

  if (status === 'stopped') {
    log(sym.info, 'Container already stopped');
    return;
  }

  const s = spinner('Stopping Neo4j...');
  const stopped = stopContainer();
  s.stop(stopped, stopped ? 'Neo4j stopped' : 'Failed to stop container');
};

/**
 * Start MCP server
 */
const startMcpServer = async (): Promise<void> => {
  // The MCP server is in a sibling directory after build
  // cli/cli.js -> mcp/mcp.server.js
  const mcpPath = join(__dirname, '..', 'mcp', 'mcp.server.js');
  await import(mcpPath);
};

/**
 * Get package version
 */
const getVersion = (): string => {
  try {
    // Go up from dist/cli to root
    const pkgPath = join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version;
  } catch {
    return 'unknown';
  }
};

// Build CLI
const program = new Command();

program.name('code-graph-context').description('MCP server for code graph analysis with Neo4j').version(getVersion());

program
  .command('init')
  .description('Set up Neo4j container and show configuration steps')
  .option('-p, --port <port>', 'Neo4j Bolt port', '7687')
  .option('--http-port <port>', 'Neo4j Browser port', '7474')
  .option('--password <password>', 'Neo4j password', 'PASSWORD')
  .option('-m, --memory <size>', 'Max heap memory (e.g., 2G, 4G)', '4G')
  .option('-f, --force', 'Recreate container even if exists')
  .action(runInit);

program.command('status').description('Check Neo4j and Docker status').action(runStatus);

program.command('stop').description('Stop the Neo4j container').action(runStop);

// Default action: start MCP server if no command given
const knownCommands = ['init', 'status', 'stop', 'help'];
const args = process.argv.slice(2);
const hasCommand = args.some((arg) => knownCommands.includes(arg) || arg.startsWith('-'));

if (args.length === 0 || !hasCommand) {
  startMcpServer().catch((err) => {
    console.error('Failed to start MCP server:', err);
    process.exit(1);
  });
} else {
  program.parse();
}
