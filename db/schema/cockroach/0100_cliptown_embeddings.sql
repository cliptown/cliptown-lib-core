-- GENERATED FILE - do not edit by hand.
-- CockroachDB declarative schema for cliptown.clip_embeddings. Distributed deployments only.
-- Regenerate:  node scripts/embeddings/generate.mjs
-- CI gate:     node scripts/embeddings/generate.mjs --check
--
-- Contract:    ores-embedding-contract 2026.08.29
-- Contract sha256: 39b8e1599d227a97f2362fdb6d3495dd38853b3345d7b05e90b64088884f9250
-- Manifest sha256: 155aac5a7bf2217847b0773bc2605011776db7f66e8d1562a3134b4fee9dcc64
-- Owning GitHub org: cliptown
--
-- This schema is owned by this repository. It is NOT assembled from
-- ORESoftware/k8s-libs-and-shared-defs; the org that owns the data owns the
-- DDL and the migrations that produce it. dpm is the only tool that applies
-- either, and apply requires human review.

-- CockroachDB differences that matter here, and how this file handles them:
--
--   * There is no pgvector extension, no halfvec, no bit_hamming_ops and no
--     binary_quantize(). The two derived candidate surfaces from the Postgres
--     file therefore do not exist. What CockroachDB has instead is C-SPANN,
--     its own distributed vector index.
--   * A CockroachDB vector index accelerates L2 distance (<->) only. That is
--     survivable precisely because the contract mandates unit-norm vectors:
--     for unit vectors ||a-b||^2 = 2 - 2*cos(a,b), so L2 ordering and cosine
--     ordering are the same ordering. This is the payoff for the
--     normalization rule, not an incidental detail.
--   * Index acceleration only applies when the filter matches prefix columns,
--     so the vector index is declared with (account_id, model_key) ahead of the
--     vector - which is also the scoping every query must apply anyway.
--   * Vector indexes are gated behind a cluster setting and block writes while
--     they backfill. Both are operator actions; see docs/embeddings.md.
--
-- Enable once per cluster, out of band, before applying this file:
--   SET CLUSTER SETTING feature.vector_index.enabled = true;

create schema if not exists cliptown;

create table if not exists cliptown.embedding_models (
  model_key              string primary key,
  provider               string not null,
  model_name             string not null,
  model_version          string not null,
  native_dims            int not null check (native_dims between 1 and 4100),
  mrl                    bool not null,
  mrl_prefix_valid       bool not null default false,
  normalized_by_provider bool not null,
  family                 string not null,
  notes                  string not null default '',
  retired_at             timestamptz
);

create table if not exists cliptown.clip_embeddings (
  id               uuid primary key default gen_random_uuid(),
  account_id       uuid not null,

  entity_kind      string not null check (entity_kind in ('clip', 'clip_group', 'source_app_context',
                                           'ocr_text', 'link_preview')),
  entity_id        uuid not null,

  model_key        string not null references cliptown.embedding_models (model_key),
  provider         string not null,
  model_name       string not null,
  model_version    string not null,
  native_dims      int not null check (native_dims between 1 and 4100),
  mrl_prefix_valid bool not null default false,

  -- Same canonical storage as Postgres: unit norm, left-aligned, zero-padded.
  embedding        vector(4100) not null,

  -- CockroachDB has no generated halfvec, so the prefix - when the model is
  -- Matryoshka and a prefix is therefore meaningful - is written by the client
  -- rather than derived by the database. The contract test asserts it matches
  -- subvector(embedding, 1, 1024); it is null for non-MRL models.
  embedding_prefix vector(1024),

  title_text       string not null default '',
  summary_text     string not null default '',
  body_text        string not null default '',
  search_document  tsvector,

  content_sha256   string not null,
  source_uri       string,
  metadata         jsonb not null default '{}'::jsonb,

  generated_at     timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  unique (account_id, entity_kind, entity_id, model_key)
);

-- Prefix columns first so the scoping filter can actually accelerate the scan.
create index if not exists cliptown_emb_scope_idx
  on cliptown.clip_embeddings (account_id, model_key, entity_kind, generated_at desc);
create index if not exists cliptown_emb_content_sha_idx
  on cliptown.clip_embeddings (account_id, model_key, content_sha256);
create index if not exists cliptown_emb_entity_idx
  on cliptown.clip_embeddings (account_id, entity_kind, entity_id);
create inverted index if not exists cliptown_emb_search_document_idx
  on cliptown.clip_embeddings (search_document);

-- C-SPANN. L2 only, which the unit-norm rule makes equivalent to cosine.
-- Applied separately from the table because it blocks writes during backfill.
-- CREATE VECTOR INDEX cliptown_emb_prefix_cspann_idx
--   ON cliptown.clip_embeddings (account_id, model_key, embedding_prefix vector_l2_ops);
