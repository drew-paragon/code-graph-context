/**
 * Local Embeddings Service
 * Uses a Python sidecar running CodeSage-Base-v2 (or configurable model).
 * Default provider — no API key required.
 */

import { debugLog } from '../../mcp/utils.js';

import { getEmbeddingSidecar } from './embedding-sidecar.js';

const BATCH_CONFIG = {
  maxBatchSize: parseInt(process.env.EMBEDDING_BATCH_SIZE ?? '', 10) || 8,
  // Max texts per HTTP request to the sidecar. Keeps memory bounded when
  // multiple parallel workers call embedTextsInBatches concurrently.
  // The sidecar still handles GPU batching internally via batch_size.
  httpBatchLimit: parseInt(process.env.EMBEDDING_HTTP_BATCH_LIMIT ?? '', 10) || 50,
} as const;

export class LocalEmbeddingsService {
  async embedText(text: string): Promise<number[]> {
    const sidecar = getEmbeddingSidecar();
    return sidecar.embedText(text);
  }

  async embedTexts(texts: string[]): Promise<(number[] | null)[]> {
    if (texts.length === 0) return [];
    const sidecar = getEmbeddingSidecar();
    return sidecar.embed(texts);
  }

  async embedTextsInBatches(texts: string[], _batchSize?: number): Promise<(number[] | null)[]> {
    if (texts.length === 0) return [];

    const gpuBatchSize = BATCH_CONFIG.maxBatchSize;
    const httpLimit = BATCH_CONFIG.httpBatchLimit;
    const httpBatches = Math.ceil(texts.length / httpLimit);
    const gpuBatchesPerRequest = Math.ceil(httpLimit / gpuBatchSize);
    console.error(
      `[embedding] ${texts.length} texts → ${httpBatches} HTTP requests (http_limit=${httpLimit}, gpu_batch_size=${gpuBatchSize}, ~${gpuBatchesPerRequest} GPU batches/req)`,
    );
    await debugLog('Batch embedding started', {
      provider: 'local',
      textCount: texts.length,
      gpuBatchSize,
      httpLimit,
      httpBatches,
    });

    const sidecar = getEmbeddingSidecar();
    const allResults: (number[] | null)[] = [];

    for (let i = 0; i < texts.length; i += httpLimit) {
      const batch = texts.slice(i, i + httpLimit);
      const batchNum = Math.floor(i / httpLimit) + 1;

      let results: number[][] | undefined;
      let lastError: Error | undefined;

      // Retry transient failures with plain HTTP. Do NOT stop/start the sidecar —
      // when the sidecar is externally managed, stop() is a no-op and the fresh
      // spawn from start() can't bind port 8787, causing a 120s startup timeout.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          results = await sidecar.embed(batch, gpuBatchSize);
          break;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          const isTransient =
            lastError.message.includes('ECONNREFUSED') ||
            lastError.message.includes('ECONNRESET') ||
            lastError.message.includes('timed out') ||
            lastError.message.includes('fetch failed');

          if (isTransient && attempt === 0) {
            console.error(
              `[embedding] Transient failure on batch ${batchNum}/${httpBatches} (${lastError.message}), retrying...`,
            );
            continue;
          }

          const textLengths = batch.map((t) => t.length);
          console.error(
            `[embedding] FAILED HTTP batch ${batchNum}/${httpBatches} (${batch.length} texts, gpuBatchSize=${gpuBatchSize}, ` +
              `textLengths=[min=${Math.min(...textLengths)}, max=${Math.max(...textLengths)}, total=${textLengths.reduce((a, b) => a + b, 0)}]): ${lastError.message}`,
          );
          throw lastError;
        }
      }

      if (results) {
        allResults.push(...results);
        if (httpBatches > 1) {
          console.error(`[embedding] HTTP batch ${batchNum}/${httpBatches}: ${batch.length} texts embedded`);
        }
      }
    }

    return allResults;
  }
}
