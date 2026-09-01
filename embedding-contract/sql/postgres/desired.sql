-- ClipTown embedding contract v2 (PostgreSQL + pgvector)
-- Forward-only, product-owned desired state. Never run from application startup.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS cliptown;

CREATE OR REPLACE FUNCTION cliptown.pad_embedding_4100(input REAL[])
RETURNS vector(4100)
LANGUAGE SQL
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN cardinality(input) BETWEEN 1 AND 4096
      THEN (input || array_fill(0.0::REAL, ARRAY[4100 - cardinality(input)]))::vector(4100)
    ELSE NULL
  END
$$;

CREATE TABLE IF NOT EXISTS cliptown.embedding_model_profiles (
  embedding_provider TEXT NOT NULL,
  model TEXT NOT NULL,
  minimum_dimensions SMALLINT NOT NULL CHECK (minimum_dimensions BETWEEN 1 AND 4096),
  default_dimensions SMALLINT NOT NULL CHECK (default_dimensions BETWEEN minimum_dimensions AND 4096),
  maximum_dimensions SMALLINT NOT NULL CHECK (maximum_dimensions BETWEEN default_dimensions AND 4096),
  supports_mrl BOOLEAN NOT NULL,
  provider_returns_normalized BOOLEAN NOT NULL,
  PRIMARY KEY (embedding_provider, model),
  CHECK (embedding_provider IN ('openai', 'google', 'voyage', 'qwen', 'nvidia', 'baai', 'custom'))
);

INSERT INTO cliptown.embedding_model_profiles
  (embedding_provider, model, minimum_dimensions, default_dimensions, maximum_dimensions, supports_mrl, provider_returns_normalized)
VALUES
  ('openai', 'text-embedding-ada-002', 1536, 1536, 1536, false, true),
  ('openai', 'text-embedding-3-small', 1, 1536, 1536, true, true),
  ('openai', 'text-embedding-3-large', 1, 3072, 3072, true, true),
  ('google', 'gemini-embedding-001', 128, 3072, 3072, true, false),
  ('qwen', 'Qwen/Qwen3-Embedding-8B', 32, 4096, 4096, true, true),
  ('nvidia', 'nvidia/NV-Embed-v2', 4096, 4096, 4096, false, true),
  ('baai', 'BAAI/bge-en-icl', 4096, 4096, 4096, false, true),
  ('voyage', 'voyage-4-large', 256, 1024, 2048, true, true),
  ('voyage', 'voyage-4', 256, 1024, 2048, true, true),
  ('voyage', 'voyage-4-lite', 256, 1024, 2048, true, true)
ON CONFLICT (embedding_provider, model) DO UPDATE SET
  minimum_dimensions = EXCLUDED.minimum_dimensions,
  default_dimensions = EXCLUDED.default_dimensions,
  maximum_dimensions = EXCLUDED.maximum_dimensions,
  supports_mrl = EXCLUDED.supports_mrl,
  provider_returns_normalized = EXCLUDED.provider_returns_normalized;

CREATE TABLE IF NOT EXISTS cliptown.semantic_embeddings (
  embedding_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  entity_kind TEXT NOT NULL CHECK (entity_kind ~ '^[a-z][a-z0-9_]*$'),
  entity_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('clip_search', 'clip_deduplication', 'discovery')),
  embedding_provider TEXT NOT NULL,
  generation_provider TEXT NULL CHECK (generation_provider IS NULL OR generation_provider IN ('openai', 'anthropic', 'google', 'qwen', 'nvidia', 'baai', 'custom')),
  model TEXT NOT NULL,
  original_dimensions SMALLINT NOT NULL CHECK (original_dimensions BETWEEN 1 AND 4096),
  storage_dimensions SMALLINT NOT NULL DEFAULT 4100 CHECK (storage_dimensions = 4100),
  embedding vector(4100) NOT NULL,
  normalization TEXT NOT NULL CHECK (normalization IN ('provider', 'l2', 'none')),
  embedding_space TEXT GENERATED ALWAYS AS
    (embedding_provider || ':' || model || ':' || original_dimensions::TEXT || ':' || normalization) STORED,
  search_text TEXT NOT NULL DEFAULT '',
  search_document TSVECTOR GENERATED ALWAYS AS
    (setweight(to_tsvector('simple', coalesce(search_text, '')), 'A') ||
     setweight(to_tsvector('simple', coalesce(entity_kind, '')), 'B')) STORED,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  source_updated_at TIMESTAMPTZ NULL,
  embedded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NULL,
  FOREIGN KEY (embedding_provider, model)
    REFERENCES cliptown.embedding_model_profiles (embedding_provider, model),
  UNIQUE (tenant_id, entity_kind, entity_id, purpose, embedding_provider, model, content_hash),
  CHECK (vector_dims(embedding) = 4100),
  CHECK (vector_norm(embedding) > 0)
);

CREATE INDEX IF NOT EXISTS semantic_embeddings_scope_idx
  ON cliptown.semantic_embeddings (tenant_id, embedding_space, purpose, entity_kind, embedded_at DESC);
CREATE INDEX IF NOT EXISTS semantic_embeddings_search_document_idx
  ON cliptown.semantic_embeddings USING GIN (search_document);
CREATE INDEX IF NOT EXISTS semantic_embeddings_binary_hnsw_idx
  ON cliptown.semantic_embeddings
  USING hnsw ((binary_quantize(embedding)::bit(4100)) bit_hamming_ops);

ALTER TABLE cliptown.semantic_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE cliptown.semantic_embeddings FORCE ROW LEVEL SECURITY;
CREATE POLICY semantic_embeddings_tenant_isolation ON cliptown.semantic_embeddings
  USING (tenant_id = current_setting('app.tenant_id', true)::UUID)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::UUID);

CREATE TABLE IF NOT EXISTS cliptown.semantic_alert_rules (
  alert_rule_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('clip_search', 'clip_deduplication', 'discovery')),
  query_embedding vector(4100) NOT NULL,
  query_original_dimensions SMALLINT NOT NULL CHECK (query_original_dimensions BETWEEN 1 AND 4096),
  query_embedding_space TEXT NOT NULL,
  query_text TEXT NOT NULL DEFAULT '',
  minimum_semantic_score DOUBLE PRECISION NOT NULL DEFAULT 0.72 CHECK (minimum_semantic_score BETWEEN -1 AND 1),
  minimum_lexical_score DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (minimum_lexical_score BETWEEN 0 AND 1),
  cooldown INTERVAL NOT NULL DEFAULT INTERVAL '1 hour',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (vector_dims(query_embedding) = 4100),
  CHECK (vector_norm(query_embedding) > 0)
);

ALTER TABLE cliptown.semantic_alert_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE cliptown.semantic_alert_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY semantic_alert_rules_tenant_isolation ON cliptown.semantic_alert_rules
  USING (tenant_id = current_setting('app.tenant_id', true)::UUID)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::UUID);

CREATE TABLE IF NOT EXISTS cliptown.semantic_match_events (
  match_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  alert_rule_id UUID NULL REFERENCES cliptown.semantic_alert_rules (alert_rule_id) ON DELETE CASCADE,
  source_embedding_id UUID NOT NULL REFERENCES cliptown.semantic_embeddings (embedding_id) ON DELETE CASCADE,
  candidate_embedding_id UUID NOT NULL REFERENCES cliptown.semantic_embeddings (embedding_id) ON DELETE CASCADE,
  semantic_score DOUBLE PRECISION NOT NULL CHECK (semantic_score BETWEEN -1 AND 1),
  lexical_score DOUBLE PRECISION NOT NULL CHECK (lexical_score BETWEEN 0 AND 1),
  combined_score DOUBLE PRECISION NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('candidate', 'suppressed', 'queued', 'sent', 'acknowledged', 'expired')),
  notification_dedupe_key TEXT NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, notification_dedupe_key),
  CHECK (source_embedding_id <> candidate_embedding_id)
);

ALTER TABLE cliptown.semantic_match_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cliptown.semantic_match_events FORCE ROW LEVEL SECURITY;
CREATE POLICY semantic_match_events_tenant_isolation ON cliptown.semantic_match_events
  USING (tenant_id = current_setting('app.tenant_id', true)::UUID)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::UUID);
