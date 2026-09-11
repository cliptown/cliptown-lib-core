// GENERATED FILE - do not edit by hand.
// Regenerate: node scripts/embeddings/generate.mjs
// Contract: ores-embedding-contract 2026.08.29 (sha256 98976465928699fb3c6c20728e4ad9f42a9d4ba0a626332f9184317c77c1e844)

import 'dart:math' as math;
import 'dart:typed_data';

const int embeddingWidth = 4100;
const int embeddingPrefixWidth = 1024;
const double normTolerance = 0.001;
const int rrfK = 60;

final class RegisteredModel {
  const RegisteredModel({
    required this.key,
    required this.provider,
    required this.modelName,
    required this.modelVersion,
    required this.nativeDims,
    required this.mrl,
    required this.normalizedByProvider,
    required this.family,
  });

  final String key;
  final String provider;
  final String modelName;
  final String modelVersion;
  final int nativeDims;

  /// Matryoshka-trained: a prefix approximates the whole vector.
  final bool mrl;

  /// False means the caller must L2-normalize before insert.
  final bool normalizedByProvider;
  final String family;

  /// Eligible for the halfvec(1024) prefix ANN index.
  bool get mrlPrefixValid => mrl && nativeDims >= embeddingPrefixWidth;
}

const List<RegisteredModel> registeredModels = <RegisteredModel>[
  RegisteredModel(
    key: 'openai:text-embedding-3-large:1',
    provider: 'openai',
    modelName: 'text-embedding-3-large',
    modelVersion: '1',
    nativeDims: 3072,
    mrl: true,
    normalizedByProvider: true,
    family: 'openai-v3',
  ),
  RegisteredModel(
    key: 'openai:text-embedding-3-small:1',
    provider: 'openai',
    modelName: 'text-embedding-3-small',
    modelVersion: '1',
    nativeDims: 1536,
    mrl: true,
    normalizedByProvider: true,
    family: 'openai-v3',
  ),
  RegisteredModel(
    key: 'openai:text-embedding-ada-002:2',
    provider: 'openai',
    modelName: 'text-embedding-ada-002',
    modelVersion: '2',
    nativeDims: 1536,
    mrl: false,
    normalizedByProvider: true,
    family: 'openai-ada',
  ),
  RegisteredModel(
    key: 'voyage:voyage-3-large:1',
    provider: 'voyage',
    modelName: 'voyage-3-large',
    modelVersion: '1',
    nativeDims: 1024,
    mrl: true,
    normalizedByProvider: true,
    family: 'voyage-3',
  ),
  RegisteredModel(
    key: 'voyage:voyage-3.5:1',
    provider: 'voyage',
    modelName: 'voyage-3.5',
    modelVersion: '1',
    nativeDims: 1024,
    mrl: true,
    normalizedByProvider: true,
    family: 'voyage-3',
  ),
  RegisteredModel(
    key: 'voyage:voyage-3.5-lite:1',
    provider: 'voyage',
    modelName: 'voyage-3.5-lite',
    modelVersion: '1',
    nativeDims: 1024,
    mrl: true,
    normalizedByProvider: true,
    family: 'voyage-3',
  ),
  RegisteredModel(
    key: 'voyage:voyage-code-3:1',
    provider: 'voyage',
    modelName: 'voyage-code-3',
    modelVersion: '1',
    nativeDims: 1024,
    mrl: true,
    normalizedByProvider: true,
    family: 'voyage-3',
  ),
  RegisteredModel(
    key: 'google:gemini-embedding-001:1',
    provider: 'google',
    modelName: 'gemini-embedding-001',
    modelVersion: '1',
    nativeDims: 3072,
    mrl: true,
    normalizedByProvider: false,
    family: 'gemini',
  ),
  RegisteredModel(
    key: 'google:text-embedding-004:1',
    provider: 'google',
    modelName: 'text-embedding-004',
    modelVersion: '1',
    nativeDims: 768,
    mrl: false,
    normalizedByProvider: true,
    family: 'gemini',
  ),
  RegisteredModel(
    key: 'google:text-multilingual-embedding-002:1',
    provider: 'google',
    modelName: 'text-multilingual-embedding-002',
    modelVersion: '1',
    nativeDims: 768,
    mrl: false,
    normalizedByProvider: true,
    family: 'gemini',
  ),
  RegisteredModel(
    key: 'qwen:Qwen3-Embedding-8B:1',
    provider: 'qwen',
    modelName: 'Qwen3-Embedding-8B',
    modelVersion: '1',
    nativeDims: 4096,
    mrl: true,
    normalizedByProvider: false,
    family: 'qwen3',
  ),
  RegisteredModel(
    key: 'qwen:Qwen3-Embedding-4B:1',
    provider: 'qwen',
    modelName: 'Qwen3-Embedding-4B',
    modelVersion: '1',
    nativeDims: 2560,
    mrl: true,
    normalizedByProvider: false,
    family: 'qwen3',
  ),
  RegisteredModel(
    key: 'qwen:Qwen3-Embedding-0.6B:1',
    provider: 'qwen',
    modelName: 'Qwen3-Embedding-0.6B',
    modelVersion: '1',
    nativeDims: 1024,
    mrl: true,
    normalizedByProvider: false,
    family: 'qwen3',
  ),
  RegisteredModel(
    key: 'nvidia:NV-Embed-v2:1',
    provider: 'nvidia',
    modelName: 'NV-Embed-v2',
    modelVersion: '1',
    nativeDims: 4096,
    mrl: false,
    normalizedByProvider: false,
    family: 'nv-embed',
  ),
  RegisteredModel(
    key: 'baai:bge-en-icl:1',
    provider: 'baai',
    modelName: 'bge-en-icl',
    modelVersion: '1',
    nativeDims: 4096,
    mrl: false,
    normalizedByProvider: false,
    family: 'bge',
  ),
  RegisteredModel(
    key: 'baai:bge-m3:1',
    provider: 'baai',
    modelName: 'bge-m3',
    modelVersion: '1',
    nativeDims: 1024,
    mrl: false,
    normalizedByProvider: true,
    family: 'bge',
  ),
  RegisteredModel(
    key: 'intfloat:e5-mistral-7b-instruct:1',
    provider: 'intfloat',
    modelName: 'e5-mistral-7b-instruct',
    modelVersion: '1',
    nativeDims: 4096,
    mrl: false,
    normalizedByProvider: false,
    family: 'e5',
  ),
];

final Map<String, RegisteredModel> _byKey = <String, RegisteredModel>{
  for (final RegisteredModel m in registeredModels) m.key: m,
};

RegisteredModel? registeredModel(String key) => _byKey[key];

const List<String> entityKinds = <String>[
  'clip',
  'clip_group',
  'source_app_context',
  'ocr_text',
  'link_preview',
];

sealed class PrepareEmbeddingResult {
  const PrepareEmbeddingResult();
}

final class PrepareEmbeddingOk extends PrepareEmbeddingResult {
  const PrepareEmbeddingOk(this.embedding);
  final Float32List embedding;
}

final class PrepareEmbeddingFailure extends PrepareEmbeddingResult {
  const PrepareEmbeddingFailure(this.reason);
  final String reason;
}

/// L2-normalize, then right zero-pad to [embeddingWidth]. The zero pad leaves
/// the norm and therefore the cosine ranking unchanged, which is what lets a
/// 1536-component OpenAI vector share a column with a 4096-component Qwen3 one.
PrepareEmbeddingResult prepareEmbedding(String modelKey, List<double> raw) {
  final RegisteredModel? model = registeredModel(modelKey);
  if (model == null) return const PrepareEmbeddingFailure('unknown-model');
  if (raw.length > embeddingWidth) return const PrepareEmbeddingFailure('width-exceeds-canonical');
  if (raw.length > model.nativeDims) return const PrepareEmbeddingFailure('width-exceeds-native');

  double sum = 0;
  for (final double x in raw) {
    sum += x * x;
  }
  final double norm = math.sqrt(sum);
  if (!(norm > 0) || !norm.isFinite) return const PrepareEmbeddingFailure('zero-vector');

  final Float32List out = Float32List(embeddingWidth);
  for (int i = 0; i < raw.length; i++) {
    out[i] = raw[i] / norm;
  }
  return PrepareEmbeddingOk(out);
}

/// Reciprocal rank fusion of the lexical and vector halves.
double rrf(int? vectorRank, int? lexicalRank) =>
    (vectorRank == null ? 0 : 1 / (rrfK + vectorRank)) +
    (lexicalRank == null ? 0 : 1 / (rrfK + lexicalRank));
