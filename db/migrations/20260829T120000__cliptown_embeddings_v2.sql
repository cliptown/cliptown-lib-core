-- GENERATED FILE - do not edit by hand.
-- Forward migration to embedding contract 2026.08.29 for cliptown.clip_embeddings.
-- Regenerate:  node scripts/embeddings/generate.mjs
-- CI gate:     node scripts/embeddings/generate.mjs --check
--
-- Contract:    ores-embedding-contract 2026.08.29
-- Contract sha256: 98976465928699fb3c6c20728e4ad9f42a9d4ba0a626332f9184317c77c1e844
-- Manifest sha256: 155aac5a7bf2217847b0773bc2605011776db7f66e8d1562a3134b4fee9dcc64
-- Owning GitHub org: cliptown
--
-- This schema is owned by this repository. It is NOT assembled from
-- ORESoftware/k8s-libs-and-shared-defs; the org that owns the data owns the
-- DDL and the migrations that produce it. dpm is the only tool that applies
-- either, and apply requires human review.

-- Migration version: 20260829T120000
-- Applied by:        dpm  (declarative-migrations/declarative-postgres-migrate.rs)
-- Apply requires human review. Services never run DDL at boot.
--
-- What this migration does:
--   * widens the stored embedding to the canonical 4100 slot, zero-padded
--   * adds the model registry and points every row at a registry entry
--   * replaces the ANN index - which cannot exist on a 4100-wide vector column -
--     with the bit and prefix candidate surfaces plus exact rerank
--   * adds weighted tsvector full-text alongside the vector, so retrieval is
--     hybrid rather than vector-only

begin;

set local search_path = cliptown, extensions, public;

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- Registry and helper functions first. The data steps below call emb_pad()
-- and join embedding_models, so these have to exist before the rows are
-- rewritten. This text is the first half of
-- db/schema/postgres/0100_cliptown_embeddings.sql, emitted from the same source, so
-- the two files cannot drift.
-- ---------------------------------------------------------------------
create schema if not exists cliptown;
create schema if not exists extensions;
create extension if not exists vector with schema extensions;

set local search_path = cliptown, extensions, public;

-- =====================================================================
-- Why this table is 4100 wide, and why the ANN index is not on it
-- =====================================================================
-- 4100 is a fixed superset width: every model in the registry below fits,
-- including the 4096-dimension open-weight retrieval models. A shorter
-- model - text-embedding-3-small at 1536, say - is stored left-aligned with
-- 2564 trailing zeros. A right zero-pad changes neither the L2 norm nor the
-- cosine similarity, so the padded row ranks exactly as the native-width row
-- would; the pad costs storage and nothing else.
--
-- pgvector can STORE 4100 dimensions but cannot INDEX them: HNSW and IVFFlat
-- top out at 2000 dimensions for the vector type and 4000 for halfvec. So
-- there is deliberately no index on the embedding column. Candidates come
-- from two derived columns that ARE indexable at this width, and the exact
-- distance is then computed on the candidate rows only. See the comments on
-- each index below.

-- ---------------------------------------------------------------------
-- Model registry. Every embedding row points at exactly one row here, and
-- no distance operator is ever evaluated across two model_key values.
-- ---------------------------------------------------------------------
create table if not exists cliptown.embedding_models (
  model_key              text primary key
                           check (octet_length(model_key) between 3 and 200),
  provider               text not null
                           check (provider in ('baai', 'google', 'intfloat', 'nvidia', 'openai',
                                     'qwen', 'voyage')),
  model_name             text not null
                           check (octet_length(model_name) between 1 and 160),
  model_version          text not null
                           check (octet_length(model_version) between 1 and 40),
  native_dims            integer not null
                           check (native_dims between 1 and 4100),
  mrl                    boolean not null,
  -- A Matryoshka-trained model concentrates information in its leading
  -- components, so a prefix of it is a real approximation of the whole. That
  -- is not true of a non-MRL model, where a prefix is an arbitrary coordinate
  -- subset. Only MRL models wide enough to fill the prefix are eligible.
  mrl_prefix_valid       boolean not null
                           generated always as (mrl and native_dims >= 1024) stored,
  normalized_by_provider boolean not null,
  family                 text not null check (octet_length(family) between 1 and 80),
  notes                  text not null default '',
  retired_at             timestamptz,
  constraint embedding_models_key_is_derived
    check (model_key = provider || ':' || model_name || ':' || model_version)
);

comment on table cliptown.embedding_models is
  'Registry of embedding models permitted in cliptown.clip_embeddings. Vendored from the fleet embedding contract 2026.08.29; regenerate rather than hand-editing.';

insert into cliptown.embedding_models
  (model_key, provider, model_name, model_version, native_dims, mrl, normalized_by_provider, family, notes)
values
  ('openai:text-embedding-3-large:1', 'openai', 'text-embedding-3-large', '1', 3072, true, true, 'openai-v3', 'Matryoshka; can be requested shortened via the dimensions parameter. Store whatever width was requested in native_dims and zero-pad the rest.'),
  ('openai:text-embedding-3-small:1', 'openai', 'text-embedding-3-small', '1', 1536, true, true, 'openai-v3', '1536 max/default; shortenable. The common case: 1536 real components followed by 2564 zeros.'),
  ('openai:text-embedding-ada-002:2', 'openai', 'text-embedding-ada-002', '2', 1536, false, true, 'openai-ada', 'Older model, superseded by text-embedding-3-*. NOT Matryoshka - excluded from the prefix index.'),
  ('voyage:voyage-3-large:1', 'voyage', 'voyage-3-large', '1', 1024, true, true, 'voyage-3', 'Anthropic does not publish a first-party embedding model; Voyage AI is the embedding provider Anthropic points customers at, so ''Anthropic embeddings'' in our code means this family. output_dimension is one of 2048, 1024 (default), 512, 256.'),
  ('voyage:voyage-3.5:1', 'voyage', 'voyage-3.5', '1', 1024, true, true, 'voyage-3', 'Same Matryoshka ladder as voyage-3-large.'),
  ('voyage:voyage-3.5-lite:1', 'voyage', 'voyage-3.5-lite', '1', 1024, true, true, 'voyage-3', 'Cheaper tier for high-volume de-duplication passes.'),
  ('voyage:voyage-code-3:1', 'voyage', 'voyage-code-3', '1', 1024, true, true, 'voyage-3', 'Code-specialized; used by the repo/diff correlation paths.'),
  ('google:gemini-embedding-001:1', 'google', 'gemini-embedding-001', '1', 3072, true, false, 'gemini', 'Matryoshka: 3072 (default), 1536 and 768 are the documented output_dimensionality values. Google returns unnormalized vectors at reduced dimensionality, so the writer MUST L2-normalize before insert - the unit-norm CHECK will reject the row otherwise.'),
  ('google:text-embedding-004:1', 'google', 'text-embedding-004', '1', 768, false, true, 'gemini', 'Older Vertex text embedding model.'),
  ('google:text-multilingual-embedding-002:1', 'google', 'text-multilingual-embedding-002', '1', 768, false, true, 'gemini', 'Multilingual sibling of text-embedding-004.'),
  ('qwen:Qwen3-Embedding-8B:1', 'qwen', 'Qwen3-Embedding-8B', '1', 4096, true, false, 'qwen3', 'The model that sets the 4096 floor for this contract. MRL / variable output. Self-hosted, so normalization is our responsibility.'),
  ('qwen:Qwen3-Embedding-4B:1', 'qwen', 'Qwen3-Embedding-4B', '1', 2560, true, false, 'qwen3', 'Mid tier of the same family.'),
  ('qwen:Qwen3-Embedding-0.6B:1', 'qwen', 'Qwen3-Embedding-0.6B', '1', 1024, true, false, 'qwen3', 'Small tier; good default for high-volume near-duplicate detection.'),
  ('nvidia:NV-Embed-v2:1', 'nvidia', 'NV-Embed-v2', '1', 4096, false, false, 'nv-embed', 'Dedicated retrieval embedding model at 4096. NOT Matryoshka - truncating it is meaningless, so it is excluded from the prefix index and relies on the bit surface for candidate generation.'),
  ('baai:bge-en-icl:1', 'baai', 'bge-en-icl', '1', 4096, false, false, 'bge', 'Mistral-based embedding model at 4096. In-context-learning retrieval model; not Matryoshka.'),
  ('baai:bge-m3:1', 'baai', 'bge-m3', '1', 1024, false, true, 'bge', 'Multilingual, multi-granularity; used where language coverage matters more than headroom.'),
  ('intfloat:e5-mistral-7b-instruct:1', 'intfloat', 'e5-mistral-7b-instruct', '1', 4096, false, false, 'e5', 'Another 4096-wide Mistral-derived retrieval model; registered so the width is already covered.')
on conflict (model_key) do update set
  native_dims            = excluded.native_dims,
  mrl                    = excluded.mrl,
  normalized_by_provider = excluded.normalized_by_provider,
  family                 = excluded.family,
  notes                  = excluded.notes;

-- ---------------------------------------------------------------------
-- Helper functions. Bodies are fully schema-qualified and carry no SET
-- clause, so the planner can still inline them into the CHECK constraints
-- and the query predicates that call them.
-- ---------------------------------------------------------------------

create or replace function cliptown.emb_width() returns integer
  language sql immutable parallel safe
  as $$ select 4100 $$;

comment on function cliptown.emb_width() is
  'Canonical stored embedding width. Single source of truth for the padding logic on every client.';

-- Right zero-pad a native-width vector up to the canonical width. Returns
-- null for a vector that is already too wide, so a bad write fails the
-- not-null constraint rather than silently truncating.
create or replace function cliptown.emb_pad(v extensions.vector)
  returns extensions.vector
  language sql immutable parallel safe
  as $$
    select case
      when v is null then null
      when extensions.vector_dims(v) = 4100 then v
      when extensions.vector_dims(v) > 4100 then null
      else ((v::real[]) || array_fill(0::real, array[4100 - extensions.vector_dims(v)]))::extensions.vector
    end
  $$;

-- True when the vector is exactly the canonical width and every component
-- past native_dims is exactly zero. This is what stops a 1536-dimension
-- vector from being written into the 4100 slot with garbage in the tail.
create or replace function cliptown.emb_is_zero_padded(v extensions.vector, native_dims integer)
  returns boolean
  language sql immutable parallel safe
  as $$
    select case
      when v is null or native_dims is null then false
      when extensions.vector_dims(v) <> 4100 then false
      when native_dims < 1 or native_dims > 4100 then false
      when native_dims = 4100 then true
      else extensions.l2_norm(extensions.subvector(v, native_dims + 1, 4100 - native_dims)) = 0
    end
  $$;

-- Unit norm is what makes cosine, inner product and L2 rank-equivalent, which
-- is what lets these same rows serve a pgvector cosine index on Postgres and
-- an L2-only vector index on CockroachDB without a second copy of the data.
create or replace function cliptown.emb_is_unit(v extensions.vector, tol double precision default 0.001)
  returns boolean
  language sql immutable parallel safe
  as $$
    select v is not null and abs(extensions.l2_norm(v) - 1) <= tol
  $$;

-- cliptown.clip_embeddings does not exist yet in any deployed environment; this migration is the
-- create. It is byte-identical in effect to db/schema/postgres/0100_cliptown_embeddings.sql,
-- which remains the declarative source of truth that dpm diffs against.

-- ---------------------------------------------------------------------
-- cliptown.clip_embeddings
-- Semantic recall over clipboard history: find the thing you copied three weeks ago from a description of it rather than its exact text.
-- ---------------------------------------------------------------------
create table if not exists cliptown.clip_embeddings (
  id                uuid primary key default gen_random_uuid(),
  account_id        uuid not null,

  entity_kind       text not null
                      check (entity_kind in ('clip', 'clip_group', 'source_app_context',
                                            'ocr_text', 'link_preview')),
  entity_id         uuid not null,

  -- Model provenance. model_key is the join key to the registry; the three
  -- parts are denormalized alongside it so a query can filter on provider or
  -- family without a join, and so the partial indexes stay immutable.
  model_key         text not null references cliptown.embedding_models (model_key),
  provider          text not null,
  model_name        text not null,
  model_version     text not null,
  native_dims       integer not null check (native_dims between 1 and 4100),
  mrl_prefix_valid  boolean not null default false,

  -- Canonical storage: full width, left-aligned, zero-padded, unit norm.
  embedding         extensions.vector(4100) not null,

  -- Candidate-generation surface 1, universal. Sign bits of the embedding.
  -- Hamming distance over them is a coarse proxy for cosine distance on any
  -- unit-norm vector, MRL or not. bit indexes go to 64000 dimensions, so this
  -- one is legal at 4100 where an index on the embedding itself is not. The
  -- zero pad quantizes to a constant run of zero bits, adding the same
  -- constant to every pairwise distance inside a model group - the ranking is
  -- unaffected.
  embedding_bits    bit(4100) generated always as
                      (extensions.binary_quantize(embedding)::bit(4100)) stored,

  -- Candidate-generation surface 2, MRL models only. The leading 1024
  -- components at half precision: 2056 bytes, indexable, and a far better
  -- approximation than the bit surface - but only for models whose training
  -- makes a prefix meaningful. The index below is partial on mrl_prefix_valid
  -- for exactly that reason.
  embedding_prefix  extensions.halfvec(1024) generated always as
                      (extensions.subvector(embedding, 1, 1024)::extensions.halfvec(1024)) stored,

  -- Lexical half of the hybrid query. Weighted so a human tag or title beats a
  -- match buried in a transcript. 'simple' rather than a stemmer: these
  -- corpora are multilingual, and a stemmer frozen into a STORED generated
  -- column cannot be changed later without rewriting the table.
  title_text        text not null default '' check (octet_length(title_text)   <= 2048),
  summary_text      text not null default '' check (octet_length(summary_text) <= 8192),
  body_text         text not null default '' check (octet_length(body_text)    <= 65536),
  search_document   tsvector generated always as (
                        setweight(to_tsvector('simple', coalesce(title_text,   '')), 'A')
                     || setweight(to_tsvector('simple', coalesce(summary_text, '')), 'B')
                     || setweight(to_tsvector('simple', coalesce(body_text,    '')), 'D')
                    ) stored,

  -- Content fingerprint of the exact text that was embedded. Lets a re-embed
  -- pass skip unchanged rows, and gives exact-duplicate detection a cheap path
  -- that never touches a vector.
  content_sha256    text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  source_uri        text check (source_uri is null or octet_length(source_uri) <= 2048),
  metadata          jsonb not null default '{}'::jsonb,

  generated_at      timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint cliptown_emb_zero_padded
    check (cliptown.emb_is_zero_padded(embedding, native_dims)),
  constraint cliptown_emb_unit_norm
    check (cliptown.emb_is_unit(embedding, 0.001)),
  constraint cliptown_emb_model_key_is_derived
    check (model_key = provider || ':' || model_name || ':' || model_version),
  constraint cliptown_emb_one_row_per_entity_per_model
    unique (account_id, entity_kind, entity_id, model_key)
);

comment on table cliptown.clip_embeddings is
  'Semantic recall over clipboard history: find the thing you copied three weeks ago from a description of it rather than its exact text.';
comment on column cliptown.clip_embeddings.embedding is
  'Unit-norm embedding, left-aligned and zero-padded to 4100. Never compare across model_key.';
comment on column cliptown.clip_embeddings.embedding_bits is
  'Sign-bit quantization of embedding. Candidate generation surface for every model; 4100 dimensions is legal for a bit index and illegal for a vector index.';
comment on column cliptown.clip_embeddings.embedding_prefix is
  'Leading 1024 components at half precision. Only meaningful, and only indexed, for Matryoshka-trained models.';

-- 4100 float32s is 16408 bytes, well past the ~8160-byte in-page tuple budget, so
-- this column is always out of line. float32 does not compress, so EXTERNAL
-- (out of line, uncompressed) skips pglz on every write and every detoast.
alter table cliptown.clip_embeddings alter column embedding set storage external;

-- ---------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------

-- Stage 1, universal: Hamming over the sign bits.
create index if not exists cliptown_emb_bits_hnsw_idx
  on cliptown.clip_embeddings using hnsw (embedding_bits extensions.bit_hamming_ops);

-- Stage 1, higher recall, MRL models only.
create index if not exists cliptown_emb_prefix_hnsw_idx
  on cliptown.clip_embeddings using hnsw (embedding_prefix extensions.halfvec_cosine_ops)
  where mrl_prefix_valid;

-- Lexical half of the hybrid query.
create index if not exists cliptown_emb_search_document_idx
  on cliptown.clip_embeddings using gin (search_document);

-- Every vector read is scoped by tenant and model before a distance operator
-- is applied; this is the index that makes that scoping cheap.
create index if not exists cliptown_emb_scope_idx
  on cliptown.clip_embeddings (account_id, model_key, entity_kind, generated_at desc);

-- Exact-duplicate short circuit: identical text under the same model.
create index if not exists cliptown_emb_content_sha_idx
  on cliptown.clip_embeddings (account_id, model_key, content_sha256);

-- Reverse lookup from the owning entity, for re-embed and delete cascades.
create index if not exists cliptown_emb_entity_idx
  on cliptown.clip_embeddings (account_id, entity_kind, entity_id);

create index if not exists cliptown_emb_metadata_idx
  on cliptown.clip_embeddings using gin (metadata jsonb_path_ops);

-- ---------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------
create or replace function cliptown.cliptown_emb_touch_updated_at()
  returns trigger language plpgsql as $$
  begin
    new.updated_at := now();
    return new;
  end
  $$;

drop trigger if exists cliptown_emb_touch_updated_at on cliptown.clip_embeddings;
create trigger cliptown_emb_touch_updated_at
  before update on cliptown.clip_embeddings
  for each row execute function cliptown.cliptown_emb_touch_updated_at();

commit;
