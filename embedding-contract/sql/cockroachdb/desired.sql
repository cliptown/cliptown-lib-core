-- ClipTown embedding contract v2 (CockroachDB)
-- Forward-only, product-owned desired state. Never run from application startup.

CREATE SCHEMA IF NOT EXISTS cliptown;

CREATE TABLE IF NOT EXISTS cliptown.embedding_model_profiles (
  embedding_provider STRING NOT NULL,
  model STRING NOT NULL,
  minimum_dimensions INT2 NOT NULL CHECK (minimum_dimensions BETWEEN 1 AND 4096),
  default_dimensions INT2 NOT NULL CHECK (default_dimensions BETWEEN minimum_dimensions AND 4096),
  maximum_dimensions INT2 NOT NULL CHECK (maximum_dimensions BETWEEN default_dimensions AND 4096),
  supports_mrl BOOL NOT NULL,
  provider_returns_normalized BOOL NOT NULL,
  PRIMARY KEY (embedding_provider, model),
  CHECK (embedding_provider IN ('openai', 'google', 'voyage', 'qwen', 'nvidia', 'baai', 'custom'))
);

UPSERT INTO cliptown.embedding_model_profiles
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
  ('voyage', 'voyage-4-lite', 256, 1024, 2048, true, true);

CREATE TABLE IF NOT EXISTS cliptown.semantic_embeddings (
  embedding_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  entity_kind STRING NOT NULL CHECK (entity_kind ~ '^[a-z][a-z0-9_]*$'),
  entity_id STRING NOT NULL,
  purpose STRING NOT NULL CHECK (purpose IN ('clip_search', 'clip_deduplication', 'discovery')),
  embedding_provider STRING NOT NULL,
  generation_provider STRING NULL CHECK (generation_provider IS NULL OR generation_provider IN ('openai', 'anthropic', 'google', 'qwen', 'nvidia', 'baai', 'custom')),
  model STRING NOT NULL,
  original_dimensions INT2 NOT NULL CHECK (original_dimensions BETWEEN 1 AND 4096),
  storage_dimensions INT2 NOT NULL DEFAULT 4100 CHECK (storage_dimensions = 4100),
  embedding VECTOR(4100) NOT NULL,
  normalization STRING NOT NULL CHECK (normalization IN ('provider', 'l2', 'none')),
  embedding_space STRING GENERATED ALWAYS AS
    (embedding_provider || ':' || model || ':' || original_dimensions::STRING || ':' || normalization) STORED,
  search_text STRING NOT NULL DEFAULT '',
  search_document TSVECTOR GENERATED ALWAYS AS
    (to_tsvector('simple', coalesce(search_text, '') || ' ' || coalesce(entity_kind, ''))) STORED,
  content_hash STRING NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  source_updated_at TIMESTAMPTZ NULL,
  embedded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NULL,
  FOREIGN KEY (embedding_provider, model)
    REFERENCES cliptown.embedding_model_profiles (embedding_provider, model),
  UNIQUE (tenant_id, entity_kind, entity_id, purpose, embedding_provider, model, content_hash)
);

CREATE INDEX IF NOT EXISTS semantic_embeddings_scope_idx
  ON cliptown.semantic_embeddings (tenant_id, embedding_space, purpose, entity_kind, embedded_at DESC);
CREATE INDEX IF NOT EXISTS semantic_embeddings_search_document_idx
  ON cliptown.semantic_embeddings USING GIN (search_document);
CREATE VECTOR INDEX semantic_embeddings_ann_idx
  ON cliptown.semantic_embeddings (tenant_id, embedding_space, purpose, embedding);

ALTER TABLE cliptown.semantic_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE cliptown.semantic_embeddings FORCE ROW LEVEL SECURITY;
CREATE POLICY semantic_embeddings_tenant_isolation ON cliptown.semantic_embeddings
  USING (tenant_id = current_setting('app.tenant_id', true)::UUID)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::UUID);

CREATE TABLE IF NOT EXISTS cliptown.semantic_alert_rules (
  alert_rule_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name STRING NOT NULL,
  purpose STRING NOT NULL CHECK (purpose IN ('clip_search', 'clip_deduplication', 'discovery')),
  query_embedding VECTOR(4100) NOT NULL,
  query_original_dimensions INT2 NOT NULL CHECK (query_original_dimensions BETWEEN 1 AND 4096),
  query_embedding_space STRING NOT NULL,
  query_text STRING NOT NULL DEFAULT '',
  minimum_semantic_score FLOAT8 NOT NULL DEFAULT 0.72 CHECK (minimum_semantic_score BETWEEN -1 AND 1),
  minimum_lexical_score FLOAT8 NOT NULL DEFAULT 0 CHECK (minimum_lexical_score BETWEEN 0 AND 1),
  cooldown INTERVAL NOT NULL DEFAULT INTERVAL '1 hour',
  enabled BOOL NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
  semantic_score FLOAT8 NOT NULL CHECK (semantic_score BETWEEN -1 AND 1),
  lexical_score FLOAT8 NOT NULL CHECK (lexical_score BETWEEN 0 AND 1),
  combined_score FLOAT8 NOT NULL,
  disposition STRING NOT NULL CHECK (disposition IN ('candidate', 'suppressed', 'queued', 'sent', 'acknowledged', 'expired')),
  notification_dedupe_key STRING NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, notification_dedupe_key),
  CHECK (source_embedding_id <> candidate_embedding_id)
);

ALTER TABLE cliptown.semantic_match_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cliptown.semantic_match_events FORCE ROW LEVEL SECURITY;
CREATE POLICY semantic_match_events_tenant_isolation ON cliptown.semantic_match_events
  USING (tenant_id = current_setting('app.tenant_id', true)::UUID)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::UUID);
