/**
 * Embeddings Service — barrel module
 *
 * Exports a common interface and a factory. Consumers do `new EmbeddingsService()`
 * and get the right implementation based on OPENAI_ENABLED.
 *
 *   OPENAI_ENABLED=true  → OpenAI text-embedding-3-large (requires OPENAI_API_KEY)
 *   default              → Local Python sidecar with Qwen3-Embedding-0.6B
 */

import { LocalEmbeddingsService } from './local-embeddings.service.js';
import { OpenAIEmbeddingsService } from './openai-embeddings.service.js';

// Re-export error classes so existing imports keep working
export { OpenAIConfigError, OpenAIAPIError } from './openai-embeddings.service.js';

export interface IEmbeddingsService {
  embedText(text: string): Promise<number[]>;
  embedTexts(texts: string[]): Promise<(number[] | null)[]>;
  embedTextsInBatches(texts: string[], batchSize?: number): Promise<(number[] | null)[]>;
}

export const EMBEDDING_BATCH_CONFIG = {
  maxBatchSize: 100,
  delayBetweenBatchesMs: 500,
} as const;

/**
 * Known dimensions per model.
 * For unlisted models, dimensions are detected at runtime from the sidecar health endpoint.
 */
export const EMBEDDING_DIMENSIONS: Record<string, number> = {
  // OpenAI models
  'text-embedding-3-large': 3072,
  'text-embedding-3-small': 1536,
  // Local models (via sidecar)
  'Qwen/Qwen3-Embedding-0.6B': 1024,
  'Qodo/Qodo-Embed-1-1.5B': 1536,
  'sentence-transformers/all-MiniLM-L6-v2': 384,
  'sentence-transformers/all-mpnet-base-v2': 768,
  'BAAI/bge-small-en-v1.5': 384,
  'BAAI/bge-base-en-v1.5': 768,
  'nomic-ai/nomic-embed-text-v1.5': 768,
};

export const isOpenAIEnabled = (): boolean => {
  return process.env.OPENAI_ENABLED?.toLowerCase() === 'true';
};

/**
 * Get the vector dimensions for the active embedding provider.
 * For known models, returns a static value. For unknown local models,
 * falls back to 1536 — the actual dimensions are verified at runtime
 * when the sidecar starts and reports via /health.
 */
export const getEmbeddingDimensions = (): number => {
  if (isOpenAIEnabled()) {
    const model = process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-large';
    return EMBEDDING_DIMENSIONS[model] ?? 3072;
  }
  const model = process.env.EMBEDDING_MODEL ?? 'Qwen/Qwen3-Embedding-0.6B';
  return EMBEDDING_DIMENSIONS[model] ?? 1536;
};

/**
 * Factory that returns the correct service based on OPENAI_ENABLED.
 * Drop-in replacement everywhere `new EmbeddingsService()` was used.
 */
export class EmbeddingsService implements IEmbeddingsService {
  private readonly impl: IEmbeddingsService;

  constructor(model?: string) {
    if (isOpenAIEnabled()) {
      this.impl = new OpenAIEmbeddingsService(model);
    } else {
      this.impl = new LocalEmbeddingsService();
    }
  }

  embedText(text: string): Promise<number[]> {
    return this.impl.embedText(text);
  }

  embedTexts(texts: string[]): Promise<(number[] | null)[]> {
    return this.impl.embedTexts(texts);
  }

  embedTextsInBatches(texts: string[], batchSize?: number): Promise<(number[] | null)[]> {
    return this.impl.embedTextsInBatches(texts, batchSize);
  }
}
