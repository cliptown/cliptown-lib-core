// GENERATED FILE - do not edit by hand.
// Regenerate: node scripts/embeddings/generate.mjs
// Contract: ores-embedding-contract 2026.08.29 (sha256 98976465928699fb3c6c20728e4ad9f42a9d4ba0a626332f9184317c77c1e844)

export const EMBEDDING_WIDTH = 4100 as const;
export const EMBEDDING_PREFIX_WIDTH = 1024 as const;
export const NORM_TOLERANCE = 0.001 as const;
export const RRF_K = 60 as const;

export type EmbeddingProvider = 'baai' | 'google' | 'intfloat' | 'nvidia' | 'openai' | 'qwen' | 'voyage';
export type EmbeddingModelKey =
  | 'openai:text-embedding-3-large:1'
  | 'openai:text-embedding-3-small:1'
  | 'openai:text-embedding-ada-002:2'
  | 'voyage:voyage-3-large:1'
  | 'voyage:voyage-3.5:1'
  | 'voyage:voyage-3.5-lite:1'
  | 'voyage:voyage-code-3:1'
  | 'google:gemini-embedding-001:1'
  | 'google:text-embedding-004:1'
  | 'google:text-multilingual-embedding-002:1'
  | 'qwen:Qwen3-Embedding-8B:1'
  | 'qwen:Qwen3-Embedding-4B:1'
  | 'qwen:Qwen3-Embedding-0.6B:1'
  | 'nvidia:NV-Embed-v2:1'
  | 'baai:bge-en-icl:1'
  | 'baai:bge-m3:1'
  | 'intfloat:e5-mistral-7b-instruct:1';
export type EntityKind =
  | 'clip'
  | 'clip_group'
  | 'source_app_context'
  | 'ocr_text'
  | 'link_preview';

export interface RegisteredModel {
  readonly key: EmbeddingModelKey;
  readonly provider: EmbeddingProvider;
  readonly modelName: string;
  readonly modelVersion: string;
  readonly nativeDims: number;
  /** Matryoshka-trained: a prefix approximates the whole vector. */
  readonly mrl: boolean;
  /** False means the caller must L2-normalize before insert. */
  readonly normalizedByProvider: boolean;
  readonly family: string;
}

export const REGISTERED_MODELS: readonly RegisteredModel[] = [
  { key: 'openai:text-embedding-3-large:1', provider: 'openai', modelName: 'text-embedding-3-large', modelVersion: '1', nativeDims: 3072, mrl: true, normalizedByProvider: true, family: 'openai-v3' },
  { key: 'openai:text-embedding-3-small:1', provider: 'openai', modelName: 'text-embedding-3-small', modelVersion: '1', nativeDims: 1536, mrl: true, normalizedByProvider: true, family: 'openai-v3' },
  { key: 'openai:text-embedding-ada-002:2', provider: 'openai', modelName: 'text-embedding-ada-002', modelVersion: '2', nativeDims: 1536, mrl: false, normalizedByProvider: true, family: 'openai-ada' },
  { key: 'voyage:voyage-3-large:1', provider: 'voyage', modelName: 'voyage-3-large', modelVersion: '1', nativeDims: 1024, mrl: true, normalizedByProvider: true, family: 'voyage-3' },
  { key: 'voyage:voyage-3.5:1', provider: 'voyage', modelName: 'voyage-3.5', modelVersion: '1', nativeDims: 1024, mrl: true, normalizedByProvider: true, family: 'voyage-3' },
  { key: 'voyage:voyage-3.5-lite:1', provider: 'voyage', modelName: 'voyage-3.5-lite', modelVersion: '1', nativeDims: 1024, mrl: true, normalizedByProvider: true, family: 'voyage-3' },
  { key: 'voyage:voyage-code-3:1', provider: 'voyage', modelName: 'voyage-code-3', modelVersion: '1', nativeDims: 1024, mrl: true, normalizedByProvider: true, family: 'voyage-3' },
  { key: 'google:gemini-embedding-001:1', provider: 'google', modelName: 'gemini-embedding-001', modelVersion: '1', nativeDims: 3072, mrl: true, normalizedByProvider: false, family: 'gemini' },
  { key: 'google:text-embedding-004:1', provider: 'google', modelName: 'text-embedding-004', modelVersion: '1', nativeDims: 768, mrl: false, normalizedByProvider: true, family: 'gemini' },
  { key: 'google:text-multilingual-embedding-002:1', provider: 'google', modelName: 'text-multilingual-embedding-002', modelVersion: '1', nativeDims: 768, mrl: false, normalizedByProvider: true, family: 'gemini' },
  { key: 'qwen:Qwen3-Embedding-8B:1', provider: 'qwen', modelName: 'Qwen3-Embedding-8B', modelVersion: '1', nativeDims: 4096, mrl: true, normalizedByProvider: false, family: 'qwen3' },
  { key: 'qwen:Qwen3-Embedding-4B:1', provider: 'qwen', modelName: 'Qwen3-Embedding-4B', modelVersion: '1', nativeDims: 2560, mrl: true, normalizedByProvider: false, family: 'qwen3' },
  { key: 'qwen:Qwen3-Embedding-0.6B:1', provider: 'qwen', modelName: 'Qwen3-Embedding-0.6B', modelVersion: '1', nativeDims: 1024, mrl: true, normalizedByProvider: false, family: 'qwen3' },
  { key: 'nvidia:NV-Embed-v2:1', provider: 'nvidia', modelName: 'NV-Embed-v2', modelVersion: '1', nativeDims: 4096, mrl: false, normalizedByProvider: false, family: 'nv-embed' },
  { key: 'baai:bge-en-icl:1', provider: 'baai', modelName: 'bge-en-icl', modelVersion: '1', nativeDims: 4096, mrl: false, normalizedByProvider: false, family: 'bge' },
  { key: 'baai:bge-m3:1', provider: 'baai', modelName: 'bge-m3', modelVersion: '1', nativeDims: 1024, mrl: false, normalizedByProvider: true, family: 'bge' },
  { key: 'intfloat:e5-mistral-7b-instruct:1', provider: 'intfloat', modelName: 'e5-mistral-7b-instruct', modelVersion: '1', nativeDims: 4096, mrl: false, normalizedByProvider: false, family: 'e5' },
];

const BY_KEY = new Map(REGISTERED_MODELS.map((m) => [m.key, m]));

export const registeredModel = (key: string): RegisteredModel | undefined => BY_KEY.get(key as EmbeddingModelKey);

/**
 * Eligible for the halfvec(1024) prefix ANN index. A non-Matryoshka model is
 * never eligible: a prefix of it is an arbitrary coordinate subset rather than a
 * low-dimensional approximation.
 */
export const mrlPrefixValid = (m: RegisteredModel): boolean => m.mrl && m.nativeDims >= EMBEDDING_PREFIX_WIDTH;

export type PrepareEmbeddingError =
  | { kind: 'unknown-model'; modelKey: string }
  | { kind: 'width-exceeds-native'; got: number; native: number }
  | { kind: 'width-exceeds-canonical'; got: number }
  | { kind: 'zero-vector' };

export type PrepareEmbeddingResult =
  | { ok: true; embedding: Float32Array }
  | { ok: false; error: PrepareEmbeddingError };

/**
 * L2-normalize, then right zero-pad to 4100. This is the only supported way to
 * build a value for the embedding column: the database CHECK constraints assert
 * exactly these two properties and will reject anything else.
 *
 * Appending zeros leaves the norm - and therefore the cosine similarity and the
 * ranking - unchanged, which is what makes a 1536-component OpenAI vector safe to
 * store in a 4100-wide slot alongside a 4096-component Qwen3 vector.
 */
export function prepareEmbedding(modelKey: string, raw: ArrayLike<number>): PrepareEmbeddingResult {
  const model = registeredModel(modelKey);
  if (!model) return { ok: false, error: { kind: 'unknown-model', modelKey } };
  if (raw.length > EMBEDDING_WIDTH) return { ok: false, error: { kind: 'width-exceeds-canonical', got: raw.length } };
  if (raw.length > model.nativeDims) {
    return { ok: false, error: { kind: 'width-exceeds-native', got: raw.length, native: model.nativeDims } };
  }

  let sum = 0;
  for (let i = 0; i < raw.length; i += 1) sum += raw[i] * raw[i];
  const norm = Math.sqrt(sum);
  if (!(norm > 0) || !Number.isFinite(norm)) return { ok: false, error: { kind: 'zero-vector' } };

  const out = new Float32Array(EMBEDDING_WIDTH);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw[i] / norm;
  return { ok: true, embedding: out };
}

/** Reciprocal rank fusion of the lexical and vector halves. */
export const rrf = (vectorRank: number | null, lexicalRank: number | null): number =>
  (vectorRank === null ? 0 : 1 / (RRF_K + vectorRank)) + (lexicalRank === null ? 0 : 1 / (RRF_K + lexicalRank));

export const ENTITY_KINDS: readonly EntityKind[] = [
  'clip',
  'clip_group',
  'source_app_context',
  'ocr_text',
  'link_preview',
];
