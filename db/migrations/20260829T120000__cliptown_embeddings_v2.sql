-- GENERATED FILE - do not edit by hand.
-- Forward migration to embedding contract 2026.08.29 for cliptown.clip_embeddings.
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

create schema if not exists cliptown;
create schema if not exists extensions;
create extension if not exists vector with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- cliptown.clip_embeddings does not exist yet in any deployed environment; this migration is the
-- create. It is byte-identical in effect to db/schema/postgres/0100_cliptown_embeddings.sql,
-- which remains the declarative source of truth that dpm diffs against.

-- ---------------------------------------------------------------------
-- Re-apply the declarative schema. Everything below is idempotent and
-- matches db/schema/postgres/0100_cliptown_embeddings.sql exactly; dpm diff
-- against that file must come back empty once this has run.
-- ---------------------------------------------------------------------
\i db/schema/postgres/0100_cliptown_embeddings.sql

commit;
