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

  async embedTextsInBatches(
    texts: string[],
    _batchSize?: number,
  ): Promise<(number[] | null)[]> {
    if (texts.length === 0) return [];

    const gpuBatchSize = BATCH_CONFIG.maxBatchSize;
    const httpLimit = BATCH_CONFIG.httpBatchLimit;
    const httpBatches = Math.ceil(texts.length / httpLimit);
    const gpuBatchesPerRequest = Math.ceil(httpLimit / gpuBatchSize);
    console.error(`[embedding] ${texts.length} texts → ${httpBatches} HTTP requests (http_limit=${httpLimit}, gpu_batch_size=${gpuBatchSize}, ~${gpuBatchesPerRequest} GPU batches/req)`);
    await debugLog('Batch embedding started', { provider: 'local', textCount: texts.length, gpuBatchSize, httpLimit, httpBatches });

    const sidecar = getEmbeddingSidecar();
    const allResults: (number[] | null)[] = [];

    for (let i = 0; i < texts.length; i += httpLimit) {
      const batch = texts.slice(i, i + httpLimit);
      const batchNum = Math.floor(i / httpLimit) + 1;

      try {
        const results = await sidecar.embed(batch, gpuBatchSize);
        allResults.push(...results);
        if (httpBatches > 1) {
          console.error(`[embedding] HTTP batch ${batchNum}/${httpBatches}: ${batch.length} texts embedded`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[embedding] FAILED HTTP batch ${batchNum}/${httpBatches} (${batch.length} texts, gpuBatchSize=${gpuBatchSize}): ${msg}`);
        throw error;
      }
    }

    return allResults;
  }
}
