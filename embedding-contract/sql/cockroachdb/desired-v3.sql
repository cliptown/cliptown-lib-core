-- ClipTown embedding model-space v3 (CockroachDB exact baseline).
-- Product-owned, additive, forward-only. No native vector index is activated here.
CREATE SCHEMA IF NOT EXISTS cliptown;
CREATE TABLE IF NOT EXISTS cliptown.embedding_generation_profiles_v3 (
 profile_key STRING PRIMARY KEY, embedding_provider STRING NOT NULL CHECK(embedding_provider IN ('openai','google','voyage','qwen','nvidia','baai','custom')),
 generation_provider STRING NULL CHECK(generation_provider IS NULL OR generation_provider IN ('openai','anthropic','google','qwen','nvidia','baai','custom')),
 model STRING NOT NULL, model_revision STRING NOT NULL, source_dimensions INT2 NOT NULL CHECK(source_dimensions BETWEEN 1 AND 4096),
 storage_dimensions INT2 NOT NULL DEFAULT 4100 CHECK(storage_dimensions=4100), normalization STRING NOT NULL,
 task_profile STRING NOT NULL, instruction_family STRING NOT NULL, instruction_sha256 STRING NOT NULL CHECK(instruction_sha256 ~ '^[0-9a-f]{64}$'),
 preprocessing_sha256 STRING NOT NULL CHECK(preprocessing_sha256 ~ '^[0-9a-f]{64}$'), input_role STRING NOT NULL,
 modality STRING NOT NULL, distance_metric STRING NOT NULL, ann_strategy STRING NOT NULL, ann_dimensions INT2 NOT NULL,
 supports_mrl BOOL NOT NULL, enabled BOOL NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), retired_at TIMESTAMPTZ NULL,
 UNIQUE(profile_key,input_role,source_dimensions,distance_metric)
);
CREATE TABLE IF NOT EXISTS cliptown.embedding_comparison_spaces_v3 (
 space_key STRING PRIMARY KEY, purpose STRING NOT NULL CHECK(purpose IN ('clip_search', 'clip_deduplication', 'discovery')), query_profile_key STRING NOT NULL,
 query_role STRING NOT NULL, document_profile_key STRING NOT NULL, document_role STRING NOT NULL,
 source_dimensions INT2 NOT NULL CHECK(source_dimensions BETWEEN 1 AND 4096), distance_metric STRING NOT NULL,
 lexical_candidate_limit INT2 NOT NULL CHECK(lexical_candidate_limit BETWEEN 1 AND 4000), semantic_candidate_limit INT2 NOT NULL CHECK(semantic_candidate_limit BETWEEN 1 AND 4000),
 result_limit INT2 NOT NULL CHECK(result_limit BETWEEN 1 AND 200), fusion_k INT2 NOT NULL DEFAULT 60, exact_rerank BOOL NOT NULL DEFAULT true,
 enabled BOOL NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), retired_at TIMESTAMPTZ NULL,
 FOREIGN KEY(query_profile_key,query_role,source_dimensions,distance_metric) REFERENCES cliptown.embedding_generation_profiles_v3(profile_key,input_role,source_dimensions,distance_metric),
 FOREIGN KEY(document_profile_key,document_role,source_dimensions,distance_metric) REFERENCES cliptown.embedding_generation_profiles_v3(profile_key,input_role,source_dimensions,distance_metric),
 UNIQUE(space_key,purpose,query_profile_key,query_role,document_profile_key,document_role,source_dimensions,distance_metric)
);
CREATE TABLE IF NOT EXISTS cliptown.semantic_embeddings_v3 (
 embedding_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, entity_kind STRING NOT NULL, entity_id STRING NOT NULL,
 purpose STRING NOT NULL CHECK(purpose IN ('clip_search', 'clip_deduplication', 'discovery')), profile_key STRING NOT NULL, input_role STRING NOT NULL, space_key STRING NOT NULL,
 query_profile_key STRING NOT NULL, query_role STRING NOT NULL, document_profile_key STRING NOT NULL, document_role STRING NOT NULL,
 source_dimensions INT2 NOT NULL CHECK(source_dimensions BETWEEN 1 AND 4096), storage_dimensions INT2 NOT NULL DEFAULT 4100 CHECK(storage_dimensions=4100),
 distance_metric STRING NOT NULL, embedding VECTOR(4100) NOT NULL,
 title_text STRING NOT NULL DEFAULT '', tag_text STRING NOT NULL DEFAULT '', body_text STRING NOT NULL DEFAULT '', source_app_text STRING NOT NULL DEFAULT '',
 search_document TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple',coalesce(title_text,'') || ' ' || coalesce(tag_text,'') || ' ' || coalesce(body_text,'') || ' ' || coalesce(source_app_text,'') || ' ' || coalesce(entity_kind,''))) STORED,
 content_sha256 STRING NOT NULL CHECK(content_sha256 ~ '^[0-9a-f]{64}$'), source_revision STRING NOT NULL,
 metadata JSONB NOT NULL DEFAULT '{}'::JSONB, embedded_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NULL,
 FOREIGN KEY(profile_key,input_role,source_dimensions,distance_metric) REFERENCES cliptown.embedding_generation_profiles_v3(profile_key,input_role,source_dimensions,distance_metric),
 FOREIGN KEY(space_key,purpose,query_profile_key,query_role,document_profile_key,document_role,source_dimensions,distance_metric)
   REFERENCES cliptown.embedding_comparison_spaces_v3(space_key,purpose,query_profile_key,query_role,document_profile_key,document_role,source_dimensions,distance_metric),
 UNIQUE(tenant_id,embedding_id,space_key,purpose,input_role),
 UNIQUE(tenant_id,entity_kind,entity_id,purpose,space_key,profile_key,content_sha256,source_revision),
 CHECK(vector_dims(embedding)=4100),
 CHECK(vector_norm(subvector(embedding,1,source_dimensions))>0),
 CHECK(vector_norm(subvector(embedding,source_dimensions+1,4100-source_dimensions))<=0.000001)
);
CREATE INDEX IF NOT EXISTS semantic_embeddings_v3_scope_idx ON cliptown.semantic_embeddings_v3(tenant_id,space_key,purpose,input_role,embedded_at DESC);
CREATE INDEX IF NOT EXISTS semantic_embeddings_v3_search_idx ON cliptown.semantic_embeddings_v3 USING GIN(search_document);
-- A later reviewed migration may create a prefix-partitioned C-SPANN index only after exact-vs-ANN recall evidence.
-- CREATE VECTOR INDEX ... ON cliptown.semantic_embeddings_v3(tenant_id,space_key,purpose,input_role,embedding);
