-- ClipTown embedding model-space v3 (PostgreSQL + pgvector).
-- Product-owned, additive, forward-only desired state. Never run at application startup.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS cliptown;

CREATE OR REPLACE FUNCTION cliptown.current_tenant_id_v3() RETURNS UUID
LANGUAGE SQL STABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN current_setting('app.tenant_id', true) ~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN current_setting('app.tenant_id', true)::UUID ELSE NULL END
$$;

CREATE OR REPLACE FUNCTION cliptown.pad_embedding_v3(input REAL[]) RETURNS VECTOR(4100)
LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE WHEN cardinality(input) BETWEEN 1 AND 4096
    THEN (input || array_fill(0.0::REAL, ARRAY[4100-cardinality(input)]))::VECTOR(4100)
    ELSE NULL END
$$;

CREATE OR REPLACE FUNCTION cliptown.embedding_is_valid_v3(input VECTOR(4100), learned SMALLINT)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT learned BETWEEN 1 AND 4096
    AND vector_dims(input)=4100
    AND vector_norm(subvector(input,1,learned))>0
    AND vector_norm(subvector(input,learned+1,4100-learned))<=0.000001
$$;

CREATE TABLE IF NOT EXISTS cliptown.embedding_generation_profiles_v3 (
  profile_key TEXT PRIMARY KEY CHECK(length(profile_key) BETWEEN 16 AND 512),
  embedding_provider TEXT NOT NULL CHECK(embedding_provider IN ('openai','google','voyage','qwen','nvidia','baai','custom')),
  generation_provider TEXT NULL CHECK(generation_provider IS NULL OR generation_provider IN ('openai','anthropic','google','qwen','nvidia','baai','custom')),
  model TEXT NOT NULL CHECK(length(model) BETWEEN 1 AND 200),
  model_revision TEXT NOT NULL CHECK(length(model_revision) BETWEEN 1 AND 200),
  source_dimensions SMALLINT NOT NULL CHECK(source_dimensions BETWEEN 1 AND 4096),
  storage_dimensions SMALLINT NOT NULL DEFAULT 4100 CHECK(storage_dimensions=4100),
  normalization TEXT NOT NULL CHECK(normalization IN ('provider','l2','none')),
  task_profile TEXT NOT NULL CHECK(length(task_profile) BETWEEN 1 AND 128),
  instruction_family TEXT NOT NULL CHECK(length(instruction_family) BETWEEN 1 AND 128),
  instruction_sha256 TEXT NOT NULL CHECK(instruction_sha256 ~ '^[0-9a-f]{64}$'),
  preprocessing_sha256 TEXT NOT NULL CHECK(preprocessing_sha256 ~ '^[0-9a-f]{64}$'),
  input_role TEXT NOT NULL CHECK(input_role IN ('symmetric','query','document','classification','clustering')),
  modality TEXT NOT NULL CHECK(length(modality) BETWEEN 1 AND 80),
  distance_metric TEXT NOT NULL CHECK(distance_metric IN ('cosine','inner-product','l2')),
  ann_strategy TEXT NOT NULL CHECK(ann_strategy IN ('halfvec-exact','halfvec-mrl','binary-full-rerank','exact-only')),
  ann_dimensions SMALLINT NOT NULL CHECK(ann_dimensions BETWEEN 0 AND 4100),
  supports_mrl BOOLEAN NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at TIMESTAMPTZ NULL,
  UNIQUE(profile_key,input_role,source_dimensions,distance_metric),
  CHECK(CASE ann_strategy
    WHEN 'halfvec-exact' THEN source_dimensions<=4000 AND ann_dimensions=source_dimensions
    WHEN 'halfvec-mrl' THEN supports_mrl AND source_dimensions>ann_dimensions AND ann_dimensions BETWEEN 1 AND 4000
    WHEN 'binary-full-rerank' THEN ann_dimensions=4100
    WHEN 'exact-only' THEN ann_dimensions=0 ELSE FALSE END)
);

CREATE TABLE IF NOT EXISTS cliptown.embedding_comparison_spaces_v3 (
  space_key TEXT PRIMARY KEY CHECK(length(space_key) BETWEEN 16 AND 512),
  purpose TEXT NOT NULL CHECK(purpose IN ('clip_search', 'clip_deduplication', 'discovery')),
  query_profile_key TEXT NOT NULL,
  query_role TEXT NOT NULL CHECK(query_role IN ('symmetric','query','classification','clustering')),
  document_profile_key TEXT NOT NULL,
  document_role TEXT NOT NULL CHECK(document_role IN ('symmetric','document','classification','clustering')),
  source_dimensions SMALLINT NOT NULL CHECK(source_dimensions BETWEEN 1 AND 4096),
  distance_metric TEXT NOT NULL CHECK(distance_metric IN ('cosine','inner-product','l2')),
  lexical_candidate_limit SMALLINT NOT NULL CHECK(lexical_candidate_limit BETWEEN 1 AND 4000),
  semantic_candidate_limit SMALLINT NOT NULL CHECK(semantic_candidate_limit BETWEEN 1 AND 4000),
  result_limit SMALLINT NOT NULL CHECK(result_limit BETWEEN 1 AND 200),
  fusion_k SMALLINT NOT NULL DEFAULT 60 CHECK(fusion_k BETWEEN 1 AND 1000),
  exact_rerank BOOLEAN NOT NULL DEFAULT TRUE CHECK(exact_rerank),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at TIMESTAMPTZ NULL,
  FOREIGN KEY(query_profile_key,query_role,source_dimensions,distance_metric)
    REFERENCES cliptown.embedding_generation_profiles_v3(profile_key,input_role,source_dimensions,distance_metric),
  FOREIGN KEY(document_profile_key,document_role,source_dimensions,distance_metric)
    REFERENCES cliptown.embedding_generation_profiles_v3(profile_key,input_role,source_dimensions,distance_metric),
  UNIQUE(space_key,purpose,query_profile_key,query_role,document_profile_key,document_role,source_dimensions,distance_metric),
  CHECK((query_role='symmetric' AND document_role='symmetric') OR
        (query_role='query' AND document_role='document') OR
        (query_role='classification' AND document_role='classification') OR
        (query_role='clustering' AND document_role='clustering'))
);

CREATE TABLE IF NOT EXISTS cliptown.semantic_embeddings_v3 (
  embedding_id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  entity_kind TEXT NOT NULL CHECK(entity_kind ~ '^[a-z][a-z0-9_]{0,79}$'),
  entity_id TEXT NOT NULL CHECK(length(entity_id) BETWEEN 1 AND 256),
  purpose TEXT NOT NULL CHECK(purpose IN ('clip_search', 'clip_deduplication', 'discovery')),
  profile_key TEXT NOT NULL,
  input_role TEXT NOT NULL CHECK(input_role IN ('symmetric','query','document','classification','clustering')),
  space_key TEXT NOT NULL,
  query_profile_key TEXT NOT NULL,
  query_role TEXT NOT NULL,
  document_profile_key TEXT NOT NULL,
  document_role TEXT NOT NULL,
  source_dimensions SMALLINT NOT NULL CHECK(source_dimensions BETWEEN 1 AND 4096),
  storage_dimensions SMALLINT NOT NULL DEFAULT 4100 CHECK(storage_dimensions=4100),
  distance_metric TEXT NOT NULL CHECK(distance_metric IN ('cosine','inner-product','l2')),
  embedding VECTOR(4100) NOT NULL,
  title_text TEXT NOT NULL DEFAULT '',
  tag_text TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  source_app_text TEXT NOT NULL DEFAULT '',
  search_document TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title_text, '')), 'A')
    || setweight(to_tsvector('simple', coalesce(tag_text, '')), 'A')
    || setweight(to_tsvector('simple', coalesce(body_text, '')), 'B')
    || setweight(to_tsvector('simple', coalesce(source_app_text, '')), 'C')
    || setweight(to_tsvector('simple',coalesce(entity_kind,'')),'D')
  ) STORED,
  content_sha256 TEXT NOT NULL CHECK(content_sha256 ~ '^[0-9a-f]{64}$'),
  source_revision TEXT NOT NULL CHECK(length(source_revision) BETWEEN 1 AND 256),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  embedded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NULL,
  PRIMARY KEY(embedding_id),
  FOREIGN KEY(profile_key,input_role,source_dimensions,distance_metric)
    REFERENCES cliptown.embedding_generation_profiles_v3(profile_key,input_role,source_dimensions,distance_metric),
  FOREIGN KEY(space_key,purpose,query_profile_key,query_role,document_profile_key,document_role,source_dimensions,distance_metric)
    REFERENCES cliptown.embedding_comparison_spaces_v3(space_key,purpose,query_profile_key,query_role,document_profile_key,document_role,source_dimensions,distance_metric),
  UNIQUE(tenant_id,embedding_id,space_key,purpose,input_role),
  UNIQUE(tenant_id,entity_kind,entity_id,purpose,space_key,profile_key,content_sha256,source_revision),
  CHECK(cliptown.embedding_is_valid_v3(embedding,source_dimensions)),
  CHECK((input_role=query_role AND profile_key=query_profile_key) OR
        (input_role=document_role AND profile_key=document_profile_key))
);

CREATE TABLE IF NOT EXISTS cliptown.semantic_alert_rules_v3 (
  alert_rule_id UUID NOT NULL DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
  space_key TEXT NOT NULL, purpose TEXT NOT NULL CHECK(purpose IN ('clip_search', 'clip_deduplication', 'discovery')),
  query_profile_key TEXT NOT NULL, query_role TEXT NOT NULL,
  document_profile_key TEXT NOT NULL, document_role TEXT NOT NULL,
  source_dimensions SMALLINT NOT NULL, distance_metric TEXT NOT NULL,
  query_embedding_id UUID NOT NULL, query_input_role TEXT NOT NULL,
  query_text TEXT NOT NULL DEFAULT '', enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(alert_rule_id), UNIQUE(tenant_id,alert_rule_id),
  FOREIGN KEY(space_key,purpose,query_profile_key,query_role,document_profile_key,document_role,source_dimensions,distance_metric)
    REFERENCES cliptown.embedding_comparison_spaces_v3(space_key,purpose,query_profile_key,query_role,document_profile_key,document_role,source_dimensions,distance_metric),
  FOREIGN KEY(tenant_id,query_embedding_id,space_key,purpose,query_input_role)
    REFERENCES cliptown.semantic_embeddings_v3(tenant_id,embedding_id,space_key,purpose,input_role),
  CHECK(query_input_role=query_role)
);

CREATE TABLE IF NOT EXISTS cliptown.semantic_match_events_v3 (
  match_event_id UUID NOT NULL DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
  alert_rule_id UUID NULL, space_key TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('clip_search', 'clip_deduplication', 'discovery')),
  source_embedding_id UUID NOT NULL, source_input_role TEXT NOT NULL,
  candidate_embedding_id UUID NOT NULL, candidate_input_role TEXT NOT NULL,
  semantic_score DOUBLE PRECISION NOT NULL CHECK(semantic_score BETWEEN -1 AND 1),
  semantic_rank INTEGER NULL CHECK(semantic_rank>0), lexical_rank INTEGER NULL CHECK(lexical_rank>0),
  fused_score DOUBLE PRECISION NOT NULL CHECK(fused_score>=0),
  disposition TEXT NOT NULL CHECK(disposition IN ('candidate','suppressed','queued','sent','acknowledged','expired')),
  notification_dedupe_key TEXT NOT NULL CHECK(length(notification_dedupe_key) BETWEEN 16 AND 512),
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(match_event_id), UNIQUE(tenant_id,match_event_id), UNIQUE(tenant_id,notification_dedupe_key),
  FOREIGN KEY(tenant_id,alert_rule_id) REFERENCES cliptown.semantic_alert_rules_v3(tenant_id,alert_rule_id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,source_embedding_id,space_key,purpose,source_input_role)
    REFERENCES cliptown.semantic_embeddings_v3(tenant_id,embedding_id,space_key,purpose,input_role) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,candidate_embedding_id,space_key,purpose,candidate_input_role)
    REFERENCES cliptown.semantic_embeddings_v3(tenant_id,embedding_id,space_key,purpose,input_role) ON DELETE CASCADE,
  CHECK(source_embedding_id<>candidate_embedding_id)
);

CREATE INDEX IF NOT EXISTS semantic_embeddings_v3_scope_idx ON cliptown.semantic_embeddings_v3(tenant_id,space_key,purpose,input_role,entity_kind,embedded_at DESC);
CREATE INDEX IF NOT EXISTS semantic_embeddings_v3_search_idx ON cliptown.semantic_embeddings_v3 USING GIN(search_document);
CREATE INDEX IF NOT EXISTS semantic_alert_rules_v3_query_fk_idx ON cliptown.semantic_alert_rules_v3(tenant_id,query_embedding_id,space_key,purpose,query_input_role);
CREATE INDEX IF NOT EXISTS semantic_match_events_v3_alert_fk_idx ON cliptown.semantic_match_events_v3(tenant_id,alert_rule_id);
CREATE INDEX IF NOT EXISTS semantic_match_events_v3_source_fk_idx ON cliptown.semantic_match_events_v3(tenant_id,source_embedding_id,space_key,purpose,source_input_role);
CREATE INDEX IF NOT EXISTS semantic_match_events_v3_candidate_fk_idx ON cliptown.semantic_match_events_v3(tenant_id,candidate_embedding_id,space_key,purpose,candidate_input_role);

ALTER TABLE cliptown.semantic_embeddings_v3 ENABLE ROW LEVEL SECURITY;
ALTER TABLE cliptown.semantic_embeddings_v3 FORCE ROW LEVEL SECURITY;
CREATE POLICY semantic_embeddings_v3_tenant_isolation ON cliptown.semantic_embeddings_v3
  USING(tenant_id=cliptown.current_tenant_id_v3()) WITH CHECK(tenant_id=cliptown.current_tenant_id_v3());
ALTER TABLE cliptown.semantic_alert_rules_v3 ENABLE ROW LEVEL SECURITY;
ALTER TABLE cliptown.semantic_alert_rules_v3 FORCE ROW LEVEL SECURITY;
CREATE POLICY semantic_alert_rules_v3_tenant_isolation ON cliptown.semantic_alert_rules_v3
  USING(tenant_id=cliptown.current_tenant_id_v3()) WITH CHECK(tenant_id=cliptown.current_tenant_id_v3());
ALTER TABLE cliptown.semantic_match_events_v3 ENABLE ROW LEVEL SECURITY;
ALTER TABLE cliptown.semantic_match_events_v3 FORCE ROW LEVEL SECURITY;
CREATE POLICY semantic_match_events_v3_tenant_isolation ON cliptown.semantic_match_events_v3
  USING(tenant_id=cliptown.current_tenant_id_v3()) WITH CHECK(tenant_id=cliptown.current_tenant_id_v3());

-- No global filtered HNSW graph is created. Exact search is the fail-closed baseline.
-- A reviewed generator may add literal per-space ANN indexes only after exact-vs-ANN recall evidence.
