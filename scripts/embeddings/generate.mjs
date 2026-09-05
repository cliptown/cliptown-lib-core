#!/usr/bin/env node
// Fleet embedding contract code generator.
//
// Reads, from the repository it is vendored into:
//   db/embedding-contract.json   the fleet-wide model registry + storage policy
//   db/org-manifest.json         this org's binding of that contract
//
// Emits, into this same repository (never into another org's repository):
//   db/schema/postgres/0100_<prefix>_embeddings.sql
//   db/schema/cockroach/0100_<prefix>_embeddings.sql
//   db/migrations/<version>__<prefix>_embeddings_v2.sql
//   db/queries/*.sql
//   generated/rust/sea-orm/<table>.rs
//   generated/typescript/embeddings.ts
//   generated/dart/embeddings.dart
//   schema/embeddings.schema.json
//   typespec/embeddings.tsp
//   docs/embeddings.md
//
// Usage:
//   node scripts/embeddings/generate.mjs            write
//   node scripts/embeddings/generate.mjs --check     fail if anything on disk differs
//
// The SQL and the migrations for this org live in THIS repository, in THIS
// GitHub org. That is deliberate: schema ownership follows the org that owns
// the data, rather than being assembled centrally in ORESoftware.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');

const contractRaw = await readFile(resolve(root, 'db/embedding-contract.json'), 'utf8');
const manifestRaw = await readFile(resolve(root, 'db/org-manifest.json'), 'utf8');
const C = JSON.parse(contractRaw);
const M = JSON.parse(manifestRaw);

const CONTRACT_SHA = createHash('sha256').update(contractRaw).digest('hex');
const MANIFEST_SHA = createHash('sha256').update(manifestRaw).digest('hex');

const W = C.storage.canonicalDimensions;           // 4100
const PREFIX_DIMS = 1024;
const TOL = C.storage.normTolerance;
const RRF_K = C.fulltext.fusionK;

const ns = M.pgSchema;
const tbl = M.table;
const T = `${ns}.${tbl}`;
const tenant = M.tenantColumn;
const p = M.prefix;
const kinds = M.entityKinds;
const models = C.models;
const providers = [...new Set(models.map((m) => m.provider))].sort();
const extra = M.extraColumns ?? [];

const sqlList = (xs) => xs.map((x) => `'${x}'`).join(', ');
const wrapList = (xs, indent, width = 88) => {
  const out = [];
  let line = '';
  for (const x of xs) {
    const piece = `'${x}'`;
    if (line && (indent + line.length + piece.length + 2) > width) { out.push(line); line = ''; }
    line += (line ? ', ' : '') + piece;
  }
  if (line) out.push(line);
  return out.map((l, i) => (i === 0 ? l : ' '.repeat(indent) + l)).join(',\n');
};

const banner = (what) => `-- GENERATED FILE - do not edit by hand.
-- ${what}
-- Regenerate:  node scripts/embeddings/generate.mjs
-- CI gate:     node scripts/embeddings/generate.mjs --check
--
-- Contract:    ${C.contract} ${C.contractVersion}
-- Contract sha256: ${CONTRACT_SHA}
-- Manifest sha256: ${MANIFEST_SHA}
-- Owning GitHub org: ${M.githubOrg}
--
-- This schema is owned by this repository. It is NOT assembled from
-- ORESoftware/k8s-libs-and-shared-defs; the org that owns the data owns the
-- DDL and the migrations that produce it. dpm is the only tool that applies
-- either, and apply requires human review.
`;

/* ------------------------------------------------------------------ */
/* Postgres: declarative schema (the dpm source of truth)              */
/* ------------------------------------------------------------------ */

const extraColsSql = extra
  .map((c) => `  ${c.name} ${c.sql}${c.notNull ? ' not null' : ''},${c.note ? `  -- ${c.note}` : ''}`)
  .join('\n');

const modelSeed = models
  .map((m) => {
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    return `  (${q(m.key)}, ${q(m.provider)}, ${q(m.modelName)}, ${q(m.modelVersion)}, ${m.nativeDims}, ${m.mrl}, ${m.normalizedByProvider}, ${q(m.family)}, ${q(m.notes)})`;
  })
  .join(',\n');

let postgres = `${banner(`Postgres declarative schema for ${T} (embeddings + hybrid search).`)}
-- Requires pgvector ${C.requires.pgvector} and PostgreSQL ${C.requires.postgres}. On pgvector 0.6.x this
-- file does not merely run slower, it fails outright: halfvec, binary_quantize(),
-- subvector(), l2_norm() and the bit_hamming_ops / halfvec_cosine_ops operator
-- classes were all introduced in 0.7.0.
--   select extversion from pg_extension where extname = 'vector';

begin;

create schema if not exists ${ns};
create schema if not exists extensions;
create extension if not exists vector with schema extensions;

set local search_path = ${ns}, extensions, public;

-- =====================================================================
-- Why this table is ${W} wide, and why the ANN index is not on it
-- =====================================================================
-- ${W} is a fixed superset width: every model in the registry below fits,
-- including the 4096-dimension open-weight retrieval models. A shorter
-- model - text-embedding-3-small at 1536, say - is stored left-aligned with
-- ${W - 1536} trailing zeros. A right zero-pad changes neither the L2 norm nor the
-- cosine similarity, so the padded row ranks exactly as the native-width row
-- would; the pad costs storage and nothing else.
--
-- pgvector can STORE ${W} dimensions but cannot INDEX them: HNSW and IVFFlat
-- top out at 2000 dimensions for the vector type and 4000 for halfvec. So
-- there is deliberately no index on the embedding column. Candidates come
-- from two derived columns that ARE indexable at this width, and the exact
-- distance is then computed on the candidate rows only. See the comments on
-- each index below.

-- ---------------------------------------------------------------------
-- Model registry. Every embedding row points at exactly one row here, and
-- no distance operator is ever evaluated across two model_key values.
-- ---------------------------------------------------------------------
create table if not exists ${ns}.embedding_models (
  model_key              text primary key
                           check (octet_length(model_key) between 3 and 200),
  provider               text not null
                           check (provider in (${wrapList(providers, 37)})),
  model_name             text not null
                           check (octet_length(model_name) between 1 and 160),
  model_version          text not null
                           check (octet_length(model_version) between 1 and 40),
  native_dims            integer not null
                           check (native_dims between 1 and ${W}),
  mrl                    boolean not null,
  -- A Matryoshka-trained model concentrates information in its leading
  -- components, so a prefix of it is a real approximation of the whole. That
  -- is not true of a non-MRL model, where a prefix is an arbitrary coordinate
  -- subset. Only MRL models wide enough to fill the prefix are eligible.
  mrl_prefix_valid       boolean not null
                           generated always as (mrl and native_dims >= ${PREFIX_DIMS}) stored,
  normalized_by_provider boolean not null,
  family                 text not null check (octet_length(family) between 1 and 80),
  notes                  text not null default '',
  retired_at             timestamptz,
  constraint embedding_models_key_is_derived
    check (model_key = provider || ':' || model_name || ':' || model_version)
);

comment on table ${ns}.embedding_models is
  'Registry of embedding models permitted in ${T}. Vendored from the fleet embedding contract ${C.contractVersion}; regenerate rather than hand-editing.';

insert into ${ns}.embedding_models
  (model_key, provider, model_name, model_version, native_dims, mrl, normalized_by_provider, family, notes)
values
${modelSeed}
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

create or replace function ${ns}.emb_width() returns integer
  language sql immutable parallel safe
  as $$ select ${W} $$;

comment on function ${ns}.emb_width() is
  'Canonical stored embedding width. Single source of truth for the padding logic on every client.';

-- Right zero-pad a native-width vector up to the canonical width. Returns
-- null for a vector that is already too wide, so a bad write fails the
-- not-null constraint rather than silently truncating.
create or replace function ${ns}.emb_pad(v extensions.vector)
  returns extensions.vector
  language sql immutable parallel safe
  as $$
    select case
      when v is null then null
      when extensions.vector_dims(v) = ${W} then v
      when extensions.vector_dims(v) > ${W} then null
      else ((v::real[]) || array_fill(0::real, array[${W} - extensions.vector_dims(v)]))::extensions.vector
    end
  $$;

-- True when the vector is exactly the canonical width and every component
-- past native_dims is exactly zero. This is what stops a 1536-dimension
-- vector from being written into the ${W} slot with garbage in the tail.
create or replace function ${ns}.emb_is_zero_padded(v extensions.vector, native_dims integer)
  returns boolean
  language sql immutable parallel safe
  as $$
    select case
      when v is null or native_dims is null then false
      when extensions.vector_dims(v) <> ${W} then false
      when native_dims < 1 or native_dims > ${W} then false
      when native_dims = ${W} then true
      else extensions.l2_norm(extensions.subvector(v, native_dims + 1, ${W} - native_dims)) = 0
    end
  $$;

-- Unit norm is what makes cosine, inner product and L2 rank-equivalent, which
-- is what lets these same rows serve a pgvector cosine index on Postgres and
-- an L2-only vector index on CockroachDB without a second copy of the data.
create or replace function ${ns}.emb_is_unit(v extensions.vector, tol double precision default ${TOL})
  returns boolean
  language sql immutable parallel safe
  as $$
    select v is not null and abs(extensions.l2_norm(v) - 1) <= tol
  $$;

--@@SCHEMA-SPLIT@@
-- ---------------------------------------------------------------------
-- ${T}
-- ${M.purpose}
-- ---------------------------------------------------------------------
create table if not exists ${T} (
  id                uuid primary key default gen_random_uuid(),
  ${tenant}${' '.repeat(Math.max(1, 18 - tenant.length))}uuid not null,

  entity_kind       text not null
                      check (entity_kind in (${wrapList(kinds, 44)})),
  entity_id         uuid not null,

  -- Model provenance. model_key is the join key to the registry; the three
  -- parts are denormalized alongside it so a query can filter on provider or
  -- family without a join, and so the partial indexes stay immutable.
  model_key         text not null references ${ns}.embedding_models (model_key),
  provider          text not null,
  model_name        text not null,
  model_version     text not null,
  native_dims       integer not null check (native_dims between 1 and ${W}),
  mrl_prefix_valid  boolean not null default false,

  -- Canonical storage: full width, left-aligned, zero-padded, unit norm.
  embedding         extensions.vector(${W}) not null,

  -- Candidate-generation surface 1, universal. Sign bits of the embedding.
  -- Hamming distance over them is a coarse proxy for cosine distance on any
  -- unit-norm vector, MRL or not. bit indexes go to 64000 dimensions, so this
  -- one is legal at ${W} where an index on the embedding itself is not. The
  -- zero pad quantizes to a constant run of zero bits, adding the same
  -- constant to every pairwise distance inside a model group - the ranking is
  -- unaffected.
  embedding_bits    bit(${W}) generated always as
                      (extensions.binary_quantize(embedding)::bit(${W})) stored,

  -- Candidate-generation surface 2, MRL models only. The leading ${PREFIX_DIMS}
  -- components at half precision: 2056 bytes, indexable, and a far better
  -- approximation than the bit surface - but only for models whose training
  -- makes a prefix meaningful. The index below is partial on mrl_prefix_valid
  -- for exactly that reason.
  embedding_prefix  extensions.halfvec(${PREFIX_DIMS}) generated always as
                      (extensions.subvector(embedding, 1, ${PREFIX_DIMS})::extensions.halfvec(${PREFIX_DIMS})) stored,

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
${extraColsSql ? extraColsSql + '\n' : ''}
  generated_at      timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint ${p}_emb_zero_padded
    check (${ns}.emb_is_zero_padded(embedding, native_dims)),
  constraint ${p}_emb_unit_norm
    check (${ns}.emb_is_unit(embedding, ${TOL})),
  constraint ${p}_emb_model_key_is_derived
    check (model_key = provider || ':' || model_name || ':' || model_version),
  constraint ${p}_emb_one_row_per_entity_per_model
    unique (${tenant}, entity_kind, entity_id, model_key)
);

comment on table ${T} is
  '${M.purpose.replace(/'/g, "''")}';
comment on column ${T}.embedding is
  'Unit-norm embedding, left-aligned and zero-padded to ${W}. Never compare across model_key.';
comment on column ${T}.embedding_bits is
  'Sign-bit quantization of embedding. Candidate generation surface for every model; ${W} dimensions is legal for a bit index and illegal for a vector index.';
comment on column ${T}.embedding_prefix is
  'Leading ${PREFIX_DIMS} components at half precision. Only meaningful, and only indexed, for Matryoshka-trained models.';

-- ${W} float32s is ${4 * W + 8} bytes, well past the ~8160-byte in-page tuple budget, so
-- this column is always out of line. float32 does not compress, so EXTERNAL
-- (out of line, uncompressed) skips pglz on every write and every detoast.
alter table ${T} alter column embedding set storage external;

-- ---------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------

-- Stage 1, universal: Hamming over the sign bits.
create index if not exists ${p}_emb_bits_hnsw_idx
  on ${T} using hnsw (embedding_bits extensions.bit_hamming_ops);

-- Stage 1, higher recall, MRL models only.
create index if not exists ${p}_emb_prefix_hnsw_idx
  on ${T} using hnsw (embedding_prefix extensions.halfvec_cosine_ops)
  where mrl_prefix_valid;

-- Lexical half of the hybrid query.
create index if not exists ${p}_emb_search_document_idx
  on ${T} using gin (search_document);

-- Every vector read is scoped by tenant and model before a distance operator
-- is applied; this is the index that makes that scoping cheap.
create index if not exists ${p}_emb_scope_idx
  on ${T} (${tenant}, model_key, entity_kind, generated_at desc);

-- Exact-duplicate short circuit: identical text under the same model.
create index if not exists ${p}_emb_content_sha_idx
  on ${T} (${tenant}, model_key, content_sha256);

-- Reverse lookup from the owning entity, for re-embed and delete cascades.
create index if not exists ${p}_emb_entity_idx
  on ${T} (${tenant}, entity_kind, entity_id);

create index if not exists ${p}_emb_metadata_idx
  on ${T} using gin (metadata jsonb_path_ops);

-- ---------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------
create or replace function ${ns}.${p}_emb_touch_updated_at()
  returns trigger language plpgsql as $$
  begin
    new.updated_at := now();
    return new;
  end
  $$;

drop trigger if exists ${p}_emb_touch_updated_at on ${T};
create trigger ${p}_emb_touch_updated_at
  before update on ${T}
  for each row execute function ${ns}.${p}_emb_touch_updated_at();

commit;
`;

/* The declarative schema in two halves.
 *
 * The widening migration has to CALL emb_pad() and JOIN embedding_models while
 * it rewrites existing rows, so those definitions must land before the data
 * steps, and the table + indexes after them. Splitting the one source here is
 * what keeps the migration and the declarative file from drifting apart: both
 * are assembled from the same text. */
const SPLIT = '--@@SCHEMA-SPLIT@@';
const pgBody = postgres
  .slice(postgres.indexOf('begin;') + 'begin;'.length)
  .replace(/\ncommit;\n?$/, '');
const [pgPartA, pgPartB] = pgBody.split(SPLIT);
if (pgPartB === undefined) throw new Error('schema split sentinel missing');
postgres = postgres.replace(SPLIT + '\n', '');

/* ------------------------------------------------------------------ */
/* CockroachDB variant                                                 */
/* ------------------------------------------------------------------ */

const cockroach = `${banner(`CockroachDB declarative schema for ${T}. Distributed deployments only.`)}
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
--     so the vector index is declared with (${tenant}, model_key) ahead of the
--     vector - which is also the scoping every query must apply anyway.
--   * Vector indexes are gated behind a cluster setting and block writes while
--     they backfill. Both are operator actions; see docs/embeddings.md.
--
-- Enable once per cluster, out of band, before applying this file:
--   SET CLUSTER SETTING feature.vector_index.enabled = true;

create schema if not exists ${ns};

create table if not exists ${ns}.embedding_models (
  model_key              string primary key,
  provider               string not null,
  model_name             string not null,
  model_version          string not null,
  native_dims            int not null check (native_dims between 1 and ${W}),
  mrl                    bool not null,
  mrl_prefix_valid       bool not null default false,
  normalized_by_provider bool not null,
  family                 string not null,
  notes                  string not null default '',
  retired_at             timestamptz
);

create table if not exists ${T} (
  id               uuid primary key default gen_random_uuid(),
  ${tenant}${' '.repeat(Math.max(1, 17 - tenant.length))}uuid not null,

  entity_kind      string not null check (entity_kind in (${wrapList(kinds, 43)})),
  entity_id        uuid not null,

  model_key        string not null references ${ns}.embedding_models (model_key),
  provider         string not null,
  model_name       string not null,
  model_version    string not null,
  native_dims      int not null check (native_dims between 1 and ${W}),
  mrl_prefix_valid bool not null default false,

  -- Same canonical storage as Postgres: unit norm, left-aligned, zero-padded.
  embedding        vector(${W}) not null,

  -- CockroachDB has no generated halfvec, so the prefix - when the model is
  -- Matryoshka and a prefix is therefore meaningful - is written by the client
  -- rather than derived by the database. The contract test asserts it matches
  -- subvector(embedding, 1, ${PREFIX_DIMS}); it is null for non-MRL models.
  embedding_prefix vector(${PREFIX_DIMS}),

  title_text       string not null default '',
  summary_text     string not null default '',
  body_text        string not null default '',
  search_document  tsvector,

  content_sha256   string not null,
  source_uri       string,
  metadata         jsonb not null default '{}'::jsonb,
${extra.map((c) => `  ${c.name} ${c.sql === 'timestamptz' ? 'timestamptz' : c.sql}${c.notNull ? ' not null' : ''},`).join('\n')}
  generated_at     timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  unique (${tenant}, entity_kind, entity_id, model_key)
);

-- Prefix columns first so the scoping filter can actually accelerate the scan.
create index if not exists ${p}_emb_scope_idx
  on ${T} (${tenant}, model_key, entity_kind, generated_at desc);
create index if not exists ${p}_emb_content_sha_idx
  on ${T} (${tenant}, model_key, content_sha256);
create index if not exists ${p}_emb_entity_idx
  on ${T} (${tenant}, entity_kind, entity_id);
create inverted index if not exists ${p}_emb_search_document_idx
  on ${T} (search_document);

-- C-SPANN. L2 only, which the unit-norm rule makes equivalent to cosine.
-- Applied separately from the table because it blocks writes during backfill.
-- CREATE VECTOR INDEX ${p}_emb_prefix_cspann_idx
--   ON ${T} (${tenant}, model_key, embedding_prefix vector_l2_ops);
`;

/* ------------------------------------------------------------------ */
/* Forward migration                                                   */
/* ------------------------------------------------------------------ */

const MIGRATION_VERSION = '20260829T120000';

const widenExisting = M.existingTable
  ? `
-- ---------------------------------------------------------------------
-- ${T} already exists at ${M.existingDims} dimensions. Widen in place.
--
-- The rewrite below is not reversible in the sense that matters: the old
-- column is dropped only after the new one is populated and validated, and
-- the old vectors are recoverable from the ${M.existingDims}-dimension prefix of the new
-- ones, exactly, because the pad is zeros. Nothing is lost.
-- ---------------------------------------------------------------------

-- 1. Old ANN index first: it is defined on the column being replaced, and at
--    ${M.existingDims} dimensions it was legal. Its replacement is a different index on a
--    different column, created at the end.
drop index if exists ${ns}.entity_embeddings_vector_idx;

-- 2. Add the widened column beside the old one.
alter table ${T}
  add column if not exists embedding_v2 extensions.vector(${W});

-- 3. Backfill. Zero-pad preserves norm, so this is value-preserving; the only
--    row that can fail is one that was not unit-norm to begin with, which the
--    validate step below will surface rather than hide.
update ${T}
   set embedding_v2 = ${ns}.emb_pad(
         case when abs(extensions.l2_norm(embedding) - 1) <= ${TOL}
              then embedding
              else extensions.l2_normalize(embedding)
         end)
 where embedding_v2 is null;

-- 4. Provenance columns. Existing rows carry model_name/model_version already;
--    derive the rest from them rather than guessing.
alter table ${T}
  add column if not exists model_key        text,
  add column if not exists provider         text,
  add column if not exists native_dims      integer,
  add column if not exists mrl_prefix_valid boolean not null default false,
  add column if not exists title_text       text not null default '',
  add column if not exists summary_text     text not null default '',
  add column if not exists body_text        text not null default '',
  add column if not exists content_sha256   text,
  add column if not exists source_uri       text,
  add column if not exists metadata         jsonb not null default '{}'::jsonb,
  add column if not exists created_at       timestamptz not null default now(),
  add column if not exists updated_at       timestamptz not null default now();

update ${T} e
   set provider         = m.provider,
       model_key        = m.model_key,
       native_dims      = coalesce(e.native_dims, m.native_dims),
       mrl_prefix_valid = m.mrl_prefix_valid
  from ${ns}.embedding_models m
 where m.model_name = e.model_name
   and m.model_version = e.model_version
   and e.model_key is distinct from m.model_key;

-- Rows whose model is not in the registry get the ada-002 default only if
-- their width matches it; anything else is left null and blocks the not-null
-- step below on purpose, so an unknown model is a review conversation rather
-- than a silent relabel.
update ${T}
   set model_key   = 'openai:text-embedding-ada-002:2',
       provider    = 'openai',
       native_dims = ${M.existingDims}
 where model_key is null
   and model_name = 'text-embedding-ada-002';

-- The pre-existing search_text column becomes the weighted body_text.
update ${T}
   set body_text = coalesce(search_text, '')
 where body_text = '' and coalesce(search_text, '') <> '';

update ${T}
   set content_sha256 = encode(digest(coalesce(search_text, ''), 'sha256'), 'hex')
 where content_sha256 is null;

-- 5. Swap. The old search_document is generated FROM the old search_text and the
--    old embedding is the narrow column; both go, and both come back below in
--    their new form.
alter table ${T} drop column if exists search_document;
alter table ${T} drop column if exists embedding;
alter table ${T} rename column embedding_v2 to embedding;
alter table ${T} alter column embedding set not null;
alter table ${T} alter column embedding set storage external;

alter table ${T}
  alter column model_key      set not null,
  alter column provider       set not null,
  alter column native_dims    set not null,
  alter column content_sha256 set not null;

-- 6. The derived columns. \`create table if not exists\` further down is a no-op
--    against a table that already exists, so an existing deployment gets these
--    here or not at all - this is the step a naive widening forgets.
alter table ${T}
  add column if not exists embedding_bits bit(${W}) generated always as
    (extensions.binary_quantize(embedding)::bit(${W})) stored,
  add column if not exists embedding_prefix extensions.halfvec(${PREFIX_DIMS}) generated always as
    (extensions.subvector(embedding, 1, ${PREFIX_DIMS})::extensions.halfvec(${PREFIX_DIMS})) stored,
  add column if not exists search_document tsvector generated always as (
      setweight(to_tsvector('simple', coalesce(title_text,   '')), 'A')
   || setweight(to_tsvector('simple', coalesce(summary_text, '')), 'B')
   || setweight(to_tsvector('simple', coalesce(body_text,    '')), 'D')
  ) stored;

-- 7. Constraints that the old table either lacks or states differently.
--    The old CHECK on entity_kind and the old UNIQUE are dropped by lookup
--    rather than by name: both were auto-named by Postgres, and an auto-name is
--    truncated at 63 bytes, so hard-coding it is how this breaks on one
--    deployment and not another.
do $emb_constraints$
declare c record;
begin
  for c in
    select con.conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = '${ns}' and rel.relname = '${tbl}'
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) ilike '%entity_kind%'
       and con.conname <> '${p}_emb_zero_padded'
  loop
    execute format('alter table ${T} drop constraint %I', c.conname);
  end loop;

  for c in
    select con.conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = '${ns}' and rel.relname = '${tbl}'
       and con.contype = 'u'
       and pg_get_constraintdef(con.oid) ilike '%model_name%'
  loop
    execute format('alter table ${T} drop constraint %I', c.conname);
  end loop;
end
$emb_constraints$;

alter table ${T}
  add constraint ${tbl}_entity_kind_check
    check (entity_kind in (${wrapList(kinds, 26)}));

alter table ${T}
  add constraint ${p}_emb_zero_padded
    check (${ns}.emb_is_zero_padded(embedding, native_dims)),
  add constraint ${p}_emb_unit_norm
    check (${ns}.emb_is_unit(embedding, ${TOL})),
  add constraint ${p}_emb_model_key_is_derived
    check (model_key = provider || ':' || model_name || ':' || model_version),
  add constraint ${p}_emb_one_row_per_entity_per_model
    unique (${tenant}, entity_kind, entity_id, model_key);

alter table ${T}
  add constraint ${tbl}_model_key_fkey
    foreign key (model_key) references ${ns}.embedding_models (model_key);

-- 8. The old narrow search_text column is now redundant: its content was copied
--    into body_text in step 4 and the weighted search_document is built from the
--    three new text columns. Dropping it is destructive, so it is left to a
--    follow-up migration once the application has stopped writing it.
--    ALTER TABLE ${T} DROP COLUMN search_text;
`
  : `
-- ${T} does not exist yet in any deployed environment; this migration is the
-- create. It is byte-identical in effect to db/schema/postgres/0100_${p}_embeddings.sql,
-- which remains the declarative source of truth that dpm diffs against.
`;

const migration = `${banner(`Forward migration to embedding contract ${C.contractVersion} for ${T}.`)}
-- Migration version: ${MIGRATION_VERSION}
-- Applied by:        dpm  (declarative-migrations/declarative-postgres-migrate.rs)
-- Apply requires human review. Services never run DDL at boot.
--
-- What this migration does:
--   * widens the stored embedding to the canonical ${W} slot, zero-padded
--   * adds the model registry and points every row at a registry entry
--   * replaces the ANN index - which cannot exist on a ${W}-wide vector column -
--     with the bit and prefix candidate surfaces plus exact rerank
--   * adds weighted tsvector full-text alongside the vector, so retrieval is
--     hybrid rather than vector-only

begin;

set local search_path = ${ns}, extensions, public;

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- Registry and helper functions first. The data steps below call emb_pad()
-- and join embedding_models, so these have to exist before the rows are
-- rewritten. This text is the first half of
-- db/schema/postgres/0100_${p}_embeddings.sql, emitted from the same source, so
-- the two files cannot drift.
-- ---------------------------------------------------------------------
${pgPartA.trim()}
${widenExisting}
${pgPartB.trim()}

commit;
`;

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

const queryHeader = (title, binds) => `${banner(title)}
-- Bind parameters:
${binds.map((b, i) => `--   $${i + 1}  ${b}`).join('\n')}
--
-- Requires search_path to include the extensions schema, or the caller must
-- schema-qualify the distance operators.
`;

const hybridSearch = `${queryHeader(`Hybrid retrieval over ${T}: lexical + vector, fused by reciprocal rank.`, [
  `${tenant} (uuid)`,
  'model_key (text) - the model the query vector came from; never mixed',
  `query embedding (vector(${W}), unit norm, zero-padded)`,
  'query text (text) - websearch syntax',
  'candidate count (int) - stage-1 fan-out, contract default ' + C.ann.defaultCandidateCount,
  'result count (int) - contract default ' + C.ann.defaultResultCount,
  'entity kinds (text[]) - null or empty means all kinds',
])}
-- Stage 1a: vector candidates. Sourced from the prefix index when the model is
-- Matryoshka, and from the bit index otherwise. Both are indexable at ${W}
-- dimensions; the embedding column itself is not.
-- Stage 1b: lexical candidates from the GIN index.
-- Stage 2:  exact cosine on the union, which is the only place the full-width
--           vector is detoasted - a few hundred rows, not the table.
-- Stage 3:  reciprocal rank fusion, k=${RRF_K}. RRF is used because ts_rank_cd and
--           cosine distance are not on a comparable scale and normalizing them
--           against each other invents a calibration we do not have.

with scope as (
  select $1::uuid as tenant, $2::text as model_key,
         $3::extensions.vector as qv, $4::text as q,
         greatest(coalesce($5::int, ${C.ann.defaultCandidateCount}), 1) as candidates,
         greatest(coalesce($6::int, ${C.ann.defaultResultCount}), 1) as results,
         $7::text[] as kinds
),
vector_candidates as (
  select e.id,
         row_number() over (
           order by case
             when e.mrl_prefix_valid
               then e.embedding_prefix <=> extensions.subvector(s.qv, 1, ${PREFIX_DIMS})::extensions.halfvec(${PREFIX_DIMS})
             else (e.embedding_bits <~> extensions.binary_quantize(s.qv)::bit(${W}))::double precision
           end
         ) as rank
    from ${T} e, scope s
   where e.${tenant} = s.tenant
     and e.model_key = s.model_key
     and (s.kinds is null or cardinality(s.kinds) = 0 or e.entity_kind = any (s.kinds))
   order by rank
   limit (select candidates from scope)
),
lexical_candidates as (
  select e.id,
         row_number() over (
           order by ts_rank_cd(e.search_document, websearch_to_tsquery('simple', s.q)) desc, e.id
         ) as rank
    from ${T} e, scope s
   where e.${tenant} = s.tenant
     and s.q is not null and s.q <> ''
     and e.search_document @@ websearch_to_tsquery('simple', s.q)
     and (s.kinds is null or cardinality(s.kinds) = 0 or e.entity_kind = any (s.kinds))
   order by rank
   limit (select candidates from scope)
),
fused as (
  select coalesce(v.id, l.id) as id,
         coalesce(1.0 / (${RRF_K} + v.rank), 0.0) + coalesce(1.0 / (${RRF_K} + l.rank), 0.0) as rrf_score,
         v.rank as vector_rank,
         l.rank as lexical_rank
    from vector_candidates v
    full outer join lexical_candidates l on l.id = v.id
)
select e.id,
       e.entity_kind,
       e.entity_id,
       e.title_text,
       e.summary_text,
       e.source_uri,
       e.metadata,
       e.model_key,
       e.native_dims,
       f.vector_rank,
       f.lexical_rank,
       f.rrf_score,
       -- Exact cosine similarity at full width, on candidate rows only.
       1 - (e.embedding <=> (select qv from scope)) as cosine_similarity,
       ts_rank_cd(e.search_document, websearch_to_tsquery('simple', (select q from scope))) as lexical_score
  from fused f
  join ${T} e on e.id = f.id
 order by f.rrf_score desc, cosine_similarity desc nulls last, e.id
 limit (select results from scope);
`;

const dedupe = `${queryHeader(`Near-duplicate detection for ${T}. ${M.dedupeIsPrimary ? 'Primary read path for this org.' : ''}`, [
  `${tenant} (uuid)`,
  'model_key (text)',
  `candidate embedding (vector(${W}), unit norm, zero-padded)`,
  'content_sha256 (text) - exact-match short circuit',
  'cosine similarity threshold (double precision) - 0.95 is a reasonable start',
  'candidate count (int)',
])}
-- Two tiers. An exact content hash match is a duplicate with no vector work at
-- all. Below that, semantic duplicates are found the same two-stage way as
-- search: indexable candidate surface, then exact cosine on the candidates.
--
-- The threshold is a parameter and not a constant on purpose: what counts as
-- "the same" differs between a notification digest and a marketing asset, and
-- baking one number into the schema would be wrong for both.

with scope as (
  select $1::uuid as tenant, $2::text as model_key, $3::extensions.vector as qv,
         $4::text as sha, coalesce($5::double precision, 0.95) as threshold,
         greatest(coalesce($6::int, ${C.ann.defaultCandidateCount}), 1) as candidates
),
exact_match as (
  select e.id, e.entity_kind, e.entity_id, 1.0::double precision as similarity,
         'content_sha256'::text as match_kind
    from ${T} e, scope s
   where e.${tenant} = s.tenant
     and e.model_key = s.model_key
     and e.content_sha256 = s.sha
),
candidates as (
  select e.id
    from ${T} e, scope s
   where e.${tenant} = s.tenant
     and e.model_key = s.model_key
   order by case
     when e.mrl_prefix_valid
       then e.embedding_prefix <=> extensions.subvector(s.qv, 1, ${PREFIX_DIMS})::extensions.halfvec(${PREFIX_DIMS})
     else (e.embedding_bits <~> extensions.binary_quantize(s.qv)::bit(${W}))::double precision
   end
   limit (select candidates from scope)
),
semantic_match as (
  select e.id, e.entity_kind, e.entity_id,
         1 - (e.embedding <=> (select qv from scope)) as similarity,
         'cosine'::text as match_kind
    from candidates c
    join ${T} e on e.id = c.id
   where 1 - (e.embedding <=> (select qv from scope)) >= (select threshold from scope)
)
select * from exact_match
union
select * from semantic_match
order by similarity desc, id
limit 50;
`;

const correlate = `${queryHeader(`Cross-kind correlation for ${T}: given one row, the rows of other kinds that are closest to it.`, [
  `${tenant} (uuid)`,
  'source row id (uuid)',
  'target entity kinds (text[])',
  'minimum cosine similarity (double precision)',
  'result count (int)',
])}
-- Correlation is the same machinery as search with the query vector read from
-- a stored row instead of computed from text, and with the source row's own
-- kind excluded so a claim correlates against evidence rather than against
-- other claims. The model_key is taken from the source row, which is what
-- keeps the comparison inside one vector space.

with src as (
  select e.id, e.${tenant} as tenant, e.model_key, e.embedding, e.embedding_bits,
         e.embedding_prefix, e.mrl_prefix_valid, e.entity_kind
    from ${T} e
   where e.id = $2::uuid and e.${tenant} = $1::uuid
),
candidates as (
  select t.id
    from ${T} t, src
   where t.${tenant} = src.tenant
     and t.model_key = src.model_key
     and t.id <> src.id
     and ($3::text[] is null or cardinality($3::text[]) = 0 or t.entity_kind = any ($3::text[]))
   order by case
     when src.mrl_prefix_valid then t.embedding_prefix <=> src.embedding_prefix
     else (t.embedding_bits <~> src.embedding_bits)::double precision
   end
   limit ${C.ann.defaultCandidateCount}
)
select t.id, t.entity_kind, t.entity_id, t.title_text, t.summary_text, t.metadata,
       1 - (t.embedding <=> src.embedding) as cosine_similarity
  from candidates c
  join ${T} t on t.id = c.id
  cross join src
 where 1 - (t.embedding <=> src.embedding) >= coalesce($4::double precision, 0.7)
 order by cosine_similarity desc, t.id
 limit greatest(coalesce($5::int, ${C.ann.defaultResultCount}), 1);
`;

const alertMatch = `${queryHeader(`Alert matching for ${T}: which saved alert rules does a newly ingested row fire?`, [
  `${tenant} (uuid)`,
  'newly ingested row id (uuid)',
  'default cosine threshold (double precision) - overridden per rule via metadata',
])}
-- An alert rule is itself a row in this table, with entity_kind = 'alert_rule'
-- and its threshold in metadata->>'threshold'. Matching a new document against
-- every rule is therefore the same nearest-neighbour question as everything
-- else here, evaluated in the direction rule <- document.
--
-- Per-rule thresholds live in metadata rather than in a column because they are
-- a property of the rule the user wrote, not of the embedding, and because a
-- rule with no explicit threshold should inherit the caller's default.

with doc as (
  select e.id, e.${tenant} as tenant, e.model_key, e.embedding, e.embedding_bits,
         e.embedding_prefix, e.mrl_prefix_valid, e.entity_kind, e.title_text
    from ${T} e
   where e.id = $2::uuid and e.${tenant} = $1::uuid
),
rule_candidates as (
  select r.id
    from ${T} r, doc
   where r.${tenant} = doc.tenant
     and r.model_key = doc.model_key
     and r.entity_kind = 'alert_rule'
   order by case
     when doc.mrl_prefix_valid then r.embedding_prefix <=> doc.embedding_prefix
     else (r.embedding_bits <~> doc.embedding_bits)::double precision
   end
   limit ${C.ann.defaultCandidateCount}
)
select r.id as rule_id,
       r.entity_id as rule_entity_id,
       r.title_text as rule_title,
       doc.id as matched_row_id,
       doc.title_text as matched_title,
       1 - (r.embedding <=> doc.embedding) as cosine_similarity,
       coalesce((r.metadata->>'threshold')::double precision, $3::double precision, 0.78) as threshold_applied
  from rule_candidates c
  join ${T} r on r.id = c.id
  cross join doc
 where 1 - (r.embedding <=> doc.embedding)
       >= coalesce((r.metadata->>'threshold')::double precision, $3::double precision, 0.78)
 order by cosine_similarity desc, r.id;
`;

/* ------------------------------------------------------------------ */
/* JSON Schema                                                         */
/* ------------------------------------------------------------------ */

const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const pascal = (s) => s.replace(/(^|[_-])([a-z0-9])/g, (_, __, c) => c.toUpperCase());
const tenantCamel = camel(tenant);
const EntityName = pascal(tbl).replace(/s$/, '');

const jsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: `https://${M.githubOrg.toLowerCase()}.github.io/schemas/embeddings.schema.json`,
  title: `${M.githubOrg} embedding contracts`,
  description:
    `Generated from db/embedding-contract.json + db/org-manifest.json. Contract ${C.contractVersion}, sha256 ${CONTRACT_SHA}. ` +
    'Do not hand-edit; run scripts/embeddings/generate.mjs.',
  $defs: {
    EmbeddingProvider: { type: 'string', enum: providers },
    EmbeddingModelKey: { type: 'string', enum: models.map((m) => m.key) },
    EntityKind: { type: 'string', enum: kinds },
    EmbeddingModel: {
      type: 'object',
      description: 'One row of the model registry. Mirrors ' + ns + '.embedding_models.',
      required: ['modelKey', 'provider', 'modelName', 'modelVersion', 'nativeDims', 'mrl', 'normalizedByProvider', 'family'],
      additionalProperties: false,
      properties: {
        modelKey: { $ref: '#/$defs/EmbeddingModelKey' },
        provider: { $ref: '#/$defs/EmbeddingProvider' },
        modelName: { type: 'string', minLength: 1, maxLength: 160 },
        modelVersion: { type: 'string', minLength: 1, maxLength: 40 },
        nativeDims: { type: 'integer', minimum: 1, maximum: W },
        mrl: { type: 'boolean', description: 'Matryoshka-trained: a prefix of the vector is a valid approximation of the whole.' },
        mrlPrefixValid: { type: 'boolean', description: `mrl AND nativeDims >= ${PREFIX_DIMS}. Governs eligibility for the prefix ANN index.` },
        normalizedByProvider: { type: 'boolean', description: 'False means the client must L2-normalize before insert.' },
        family: { type: 'string' },
        notes: { type: 'string' },
      },
    },
    EmbeddingVector: {
      type: 'array',
      description:
        `Canonical stored embedding: exactly ${W} float components, left-aligned to nativeDims, ` +
        `zero on every index past nativeDims, and L2-normalized to unit length within ${TOL}.`,
      items: { type: 'number' },
      minItems: W,
      maxItems: W,
    },
    [EntityName]: {
      type: 'object',
      description: M.purpose,
      required: [
        'id', tenantCamel, 'entityKind', 'entityId', 'modelKey', 'provider', 'modelName',
        'modelVersion', 'nativeDims', 'embedding', 'contentSha256', 'generatedAt',
      ],
      additionalProperties: false,
      properties: {
        id: { type: 'string', format: 'uuid' },
        [tenantCamel]: { type: 'string', format: 'uuid' },
        entityKind: { $ref: '#/$defs/EntityKind' },
        entityId: { type: 'string', format: 'uuid' },
        modelKey: { $ref: '#/$defs/EmbeddingModelKey' },
        provider: { $ref: '#/$defs/EmbeddingProvider' },
        modelName: { type: 'string', minLength: 1, maxLength: 160 },
        modelVersion: { type: 'string', minLength: 1, maxLength: 40 },
        nativeDims: { type: 'integer', minimum: 1, maximum: W },
        mrlPrefixValid: { type: 'boolean', default: false },
        embedding: { $ref: '#/$defs/EmbeddingVector' },
        titleText: { type: 'string', maxLength: 2048, default: '', description: 'Weight A in the tsvector: titles, names, human tags.' },
        summaryText: { type: 'string', maxLength: 8192, default: '', description: 'Weight B: human descriptions, captions, abstracts.' },
        bodyText: { type: 'string', maxLength: 65536, default: '', description: 'Weight D: full body, transcript or OCR text.' },
        contentSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        sourceUri: { type: ['string', 'null'], maxLength: 2048 },
        metadata: { type: 'object', default: {} },
        ...Object.fromEntries(extra.map((c) => [camel(c.name), {
          type: c.notNull ? (c.sql.startsWith('timestamptz') ? 'string' : 'string') : ['string', 'null'],
          ...(c.sql.startsWith('timestamptz') ? { format: 'date-time' } : { format: 'uuid' }),
          description: c.note ?? '',
        }])),
        generatedAt: { type: 'string', format: 'date-time' },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
      },
    },
    HybridSearchRequest: {
      type: 'object',
      required: [tenantCamel, 'modelKey'],
      additionalProperties: false,
      properties: {
        [tenantCamel]: { type: 'string', format: 'uuid' },
        modelKey: { $ref: '#/$defs/EmbeddingModelKey' },
        queryText: { type: ['string', 'null'], maxLength: 4096 },
        queryEmbedding: { oneOf: [{ $ref: '#/$defs/EmbeddingVector' }, { type: 'null' }] },
        entityKinds: { type: 'array', items: { $ref: '#/$defs/EntityKind' }, default: [] },
        candidateCount: { type: 'integer', minimum: 1, maximum: 4000, default: C.ann.defaultCandidateCount },
        resultCount: { type: 'integer', minimum: 1, maximum: 200, default: C.ann.defaultResultCount },
      },
    },
    HybridSearchHit: {
      type: 'object',
      required: ['id', 'entityKind', 'entityId', 'rrfScore'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', format: 'uuid' },
        entityKind: { $ref: '#/$defs/EntityKind' },
        entityId: { type: 'string', format: 'uuid' },
        titleText: { type: 'string' },
        summaryText: { type: 'string' },
        sourceUri: { type: ['string', 'null'] },
        metadata: { type: 'object' },
        modelKey: { $ref: '#/$defs/EmbeddingModelKey' },
        vectorRank: { type: ['integer', 'null'] },
        lexicalRank: { type: ['integer', 'null'] },
        rrfScore: { type: 'number' },
        cosineSimilarity: { type: ['number', 'null'], minimum: -1, maximum: 1 },
        lexicalScore: { type: ['number', 'null'] },
      },
    },
  },
};

/* ------------------------------------------------------------------ */
/* TypeSpec                                                            */
/* ------------------------------------------------------------------ */

const tspEnum = (name, values, doc) =>
  `@doc("${doc}")\nunion ${name} {\n${values.map((v) => `  "${v}",`).join('\n')}\n}\n`;

const typespec = `// GENERATED FILE - do not edit by hand.
// Regenerate: node scripts/embeddings/generate.mjs
// Contract: ${C.contract} ${C.contractVersion} (sha256 ${CONTRACT_SHA})
//
// TypeSpec is the interface-level statement of the same contract the SQL in
// db/schema enforces at the storage level. When they disagree, the SQL wins and
// this file is stale - the generator is what keeps them from disagreeing.

import "@typespec/json-schema";
using TypeSpec.JsonSchema;

@jsonSchema
namespace ${pascal(M.githubOrg.replace(/[^A-Za-z0-9]/g, '_'))}.Embeddings;

${tspEnum('EmbeddingProvider', providers, 'Embedding provider. Anthropic ships no first-party embedding model; the voyage provider is what "Anthropic embeddings" means in our code.')}
${tspEnum('EmbeddingModelKey', models.map((m) => m.key), 'provider:modelName:modelVersion. Two rows may only be compared when this matches.')}
${tspEnum('EntityKind', kinds, `What the embedded row describes in ${M.githubOrg}.`)}

@doc("""
Canonical stored embedding: exactly ${W} components, left-aligned to nativeDims,
zero past nativeDims, L2-normalized to unit length within ${TOL}. The zero pad is
norm-preserving, so a ${1536}-component OpenAI vector padded to ${W} ranks exactly as it
would at its native width.
""")
@minItems(${W})
@maxItems(${W})
model EmbeddingVector is float32[];

@doc("One row of the model registry, mirroring ${ns}.embedding_models.")
model EmbeddingModel {
  modelKey: EmbeddingModelKey;
  provider: EmbeddingProvider;
  @maxLength(160) modelName: string;
  @maxLength(40) modelVersion: string;

  @doc("Native width of this model before padding.")
  @minValue(1) @maxValue(${W}) nativeDims: int32;

  @doc("Matryoshka-trained: a prefix of the vector approximates the whole. Non-MRL models are excluded from the prefix ANN index because a prefix of them is an arbitrary coordinate subset.")
  mrl: boolean;

  @doc("mrl AND nativeDims >= ${PREFIX_DIMS}. Governs eligibility for the halfvec(${PREFIX_DIMS}) prefix index.")
  mrlPrefixValid: boolean;

  @doc("False means the client must L2-normalize before insert or the unit-norm CHECK rejects the row.")
  normalizedByProvider: boolean;

  family: string;
  notes?: string;
}

@doc("${M.purpose.replace(/"/g, '\\"')}")
model ${EntityName} {
  @format("uuid") id: string;
  @format("uuid") ${tenantCamel}: string;

  entityKind: EntityKind;
  @format("uuid") entityId: string;

  modelKey: EmbeddingModelKey;
  provider: EmbeddingProvider;
  @maxLength(160) modelName: string;
  @maxLength(40) modelVersion: string;
  @minValue(1) @maxValue(${W}) nativeDims: int32;
  mrlPrefixValid: boolean;

  embedding: EmbeddingVector;

  @doc("Weight A in the tsvector: titles, names, human tags.")
  @maxLength(2048) titleText: string;
  @doc("Weight B: human descriptions, captions, abstracts.")
  @maxLength(8192) summaryText: string;
  @doc("Weight D: full body, transcript or OCR text.")
  @maxLength(65536) bodyText: string;

  @doc("sha256 of the exact text that was embedded. Lets a re-embed pass skip unchanged rows and gives exact-duplicate detection a path that never touches a vector.")
  @pattern("^[0-9a-f]{64}$") contentSha256: string;

  @maxLength(2048) sourceUri?: string | null;
  metadata: Record<unknown>;
${extra.map((c) => `  ${c.sql.startsWith('timestamptz') ? `@format("date-time")` : `@format("uuid")`} ${camel(c.name)}${c.notNull ? '' : '?'}: string${c.notNull ? '' : ' | null'};`).join('\n')}

  @format("date-time") generatedAt: string;
  @format("date-time") createdAt: string;
  @format("date-time") updatedAt: string;
}

@doc("A hybrid retrieval request. queryText drives the lexical half, queryEmbedding the vector half; supplying only one is legal and degrades to that half alone.")
model HybridSearchRequest {
  @format("uuid") ${tenantCamel}: string;
  modelKey: EmbeddingModelKey;
  @maxLength(4096) queryText?: string | null;
  queryEmbedding?: EmbeddingVector | null;
  entityKinds?: EntityKind[];
  @minValue(1) @maxValue(4000) candidateCount?: int32 = ${C.ann.defaultCandidateCount};
  @minValue(1) @maxValue(200) resultCount?: int32 = ${C.ann.defaultResultCount};
}

@doc("One fused hit. vectorRank and lexicalRank are null when that half did not retrieve the row; rrfScore is the reciprocal-rank fusion of whichever halves did.")
model HybridSearchHit {
  @format("uuid") id: string;
  entityKind: EntityKind;
  @format("uuid") entityId: string;
  titleText: string;
  summaryText: string;
  sourceUri?: string | null;
  metadata: Record<unknown>;
  modelKey: EmbeddingModelKey;
  vectorRank?: int32 | null;
  lexicalRank?: int32 | null;
  rrfScore: float64;
  @minValue(-1) @maxValue(1) cosineSimilarity?: float64 | null;
  lexicalScore?: float64 | null;
}
`;

/* ------------------------------------------------------------------ */
/* SeaORM entity                                                       */
/* ------------------------------------------------------------------ */

const rustExtra = extra
  .map((c) => `    pub ${c.name}: ${c.sql.startsWith('timestamptz') ? (c.notNull ? 'DateTimeWithTimeZone' : 'Option<DateTimeWithTimeZone>') : c.notNull ? 'Uuid' : 'Option<Uuid>'},`)
  .join('\n');

const rust = `// GENERATED FILE - do not edit by hand.
// Regenerate: node scripts/embeddings/generate.mjs
// Contract: ${C.contract} ${C.contractVersion} (sha256 ${CONTRACT_SHA})
//
// SeaORM entity for ${T}. SeaORM is the application ORM for this fleet; direct
// sqlx and tokio-postgres are forbidden, and this crate never runs DDL - dpm
// owns migrations and apply requires human review.
//
// The three derived columns (embedding_bits, embedding_prefix, search_document)
// are database-generated and therefore read-only here. Writing them is not a
// missing feature; Postgres rejects it.

use sea_orm::entity::prelude::*;

/// Canonical stored embedding width. Every vector written to this table is
/// exactly this long: left-aligned to \`native_dims\`, zero past it, unit norm.
pub const EMBEDDING_WIDTH: usize = ${W};

/// Width of the Matryoshka prefix that carries the secondary ANN index.
pub const EMBEDDING_PREFIX_WIDTH: usize = ${PREFIX_DIMS};

/// Tolerance on the unit-norm check, matching the SQL CHECK constraint.
pub const NORM_TOLERANCE: f32 = ${TOL};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(schema_name = "${ns}", table_name = "${tbl}")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub ${tenant}: Uuid,

    pub entity_kind: String,
    pub entity_id: Uuid,

    pub model_key: String,
    pub provider: String,
    pub model_name: String,
    pub model_version: String,
    pub native_dims: i32,
    pub mrl_prefix_valid: bool,

    /// pgvector \`vector(${W})\`. Surfaced as \`Vec<f32>\` through the
    /// \`postgres-vector\` feature; see \`docs/embeddings.md\` for the wiring.
    #[sea_orm(column_type = "custom(\\"vector(${W})\\")")]
    pub embedding: Vec<f32>,

    /// Generated by the database from \`embedding\`. Read-only.
    #[sea_orm(ignore)]
    pub embedding_bits: Option<Vec<u8>>,
    /// Generated by the database from \`embedding\`. Read-only.
    #[sea_orm(ignore)]
    pub embedding_prefix: Option<Vec<f32>>,

    pub title_text: String,
    pub summary_text: String,
    pub body_text: String,

    pub content_sha256: String,
    pub source_uri: Option<String>,
    pub metadata: Json,
${rustExtra ? rustExtra + '\n' : ''}
    pub generated_at: DateTimeWithTimeZone,
    pub created_at: DateTimeWithTimeZone,
    pub updated_at: DateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::embedding_models::Entity",
        from = "Column::ModelKey",
        to = "super::embedding_models::Column::ModelKey"
    )]
    EmbeddingModel,
}

impl Related<super::embedding_models::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::EmbeddingModel.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}

/// The entity kinds this table accepts, matching the SQL CHECK constraint.
pub const ENTITY_KINDS: &[&str] = &[
${kinds.map((k) => `    "${k}",`).join('\n')}
];

/// One registry entry, mirroring \`${ns}.embedding_models\`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RegisteredModel {
    pub key: &'static str,
    pub provider: &'static str,
    pub model_name: &'static str,
    pub model_version: &'static str,
    pub native_dims: usize,
    pub mrl: bool,
    pub normalized_by_provider: bool,
    pub family: &'static str,
}

impl RegisteredModel {
    /// Eligible for the \`halfvec(${PREFIX_DIMS})\` prefix index. A non-Matryoshka model is
    /// never eligible: a prefix of it is an arbitrary coordinate subset, not an
    /// approximation of the whole vector.
    pub const fn mrl_prefix_valid(&self) -> bool {
        self.mrl && self.native_dims >= EMBEDDING_PREFIX_WIDTH
    }
}

pub const REGISTERED_MODELS: &[RegisteredModel] = &[
${models
  .map(
    (m) => `    RegisteredModel {
        key: "${m.key}",
        provider: "${m.provider}",
        model_name: "${m.modelName}",
        model_version: "${m.modelVersion}",
        native_dims: ${m.nativeDims},
        mrl: ${m.mrl},
        normalized_by_provider: ${m.normalizedByProvider},
        family: "${m.family}",
    },`,
  )
  .join('\n')}
];

pub fn registered_model(key: &str) -> Option<&'static RegisteredModel> {
    let mut i = 0;
    while i < REGISTERED_MODELS.len() {
        if REGISTERED_MODELS[i].key.as_bytes() == key.as_bytes() {
            return Some(&REGISTERED_MODELS[i]);
        }
        i += 1;
    }
    None
}

/// Errors a vector can fail on before it ever reaches Postgres. These mirror the
/// CHECK constraints exactly, so a caller that passes \`prepare_embedding\` will
/// not be rejected by the database for these reasons.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EmbeddingError {
    UnknownModel,
    /// The vector is wider than the model says it should be.
    WidthExceedsNative { got: usize, native: usize },
    /// The vector is wider than the canonical slot; nothing can be done with it.
    WidthExceedsCanonical { got: usize },
    /// All components are zero, so it cannot be normalized.
    ZeroVector,
}

/// Normalize to unit length and right zero-pad to the canonical width.
///
/// This is the only supported way to produce a value for the \`embedding\`
/// column. Padding after normalizing is deliberate and not interchangeable with
/// the reverse: appending zeros does not change the L2 norm, so normalize-then-pad
/// and pad-then-normalize agree - but doing it in this order keeps the
/// normalization defined over the model's own components only.
pub fn prepare_embedding(model_key: &str, raw: &[f32]) -> Result<Vec<f32>, EmbeddingError> {
    let model = registered_model(model_key).ok_or(EmbeddingError::UnknownModel)?;

    if raw.len() > EMBEDDING_WIDTH {
        return Err(EmbeddingError::WidthExceedsCanonical { got: raw.len() });
    }
    if raw.len() > model.native_dims {
        return Err(EmbeddingError::WidthExceedsNative {
            got: raw.len(),
            native: model.native_dims,
        });
    }

    let norm = raw.iter().map(|x| x * x).sum::<f32>().sqrt();
    if !(norm > 0.0) || !norm.is_finite() {
        return Err(EmbeddingError::ZeroVector);
    }

    let mut out = Vec::with_capacity(EMBEDDING_WIDTH);
    out.extend(raw.iter().map(|x| x / norm));
    out.resize(EMBEDDING_WIDTH, 0.0);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pads_to_the_canonical_width() {
        let raw = vec![1.0f32; 1536];
        let v = prepare_embedding("openai:text-embedding-3-small:1", &raw).unwrap();
        assert_eq!(v.len(), EMBEDDING_WIDTH);
        assert!(v[1536..].iter().all(|x| *x == 0.0), "tail must be exactly zero");
    }

    #[test]
    fn pad_is_norm_preserving() {
        let raw: Vec<f32> = (0..1536).map(|i| (i as f32) - 700.0).collect();
        let v = prepare_embedding("openai:text-embedding-3-small:1", &raw).unwrap();
        let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() <= NORM_TOLERANCE, "norm was {norm}");
    }

    #[test]
    fn rejects_a_vector_wider_than_its_model() {
        let raw = vec![1.0f32; 3072];
        assert_eq!(
            prepare_embedding("openai:text-embedding-3-small:1", &raw),
            Err(EmbeddingError::WidthExceedsNative { got: 3072, native: 1536 })
        );
    }

    #[test]
    fn the_4096_models_fit_with_headroom() {
        for key in ["qwen:Qwen3-Embedding-8B:1", "nvidia:NV-Embed-v2:1", "baai:bge-en-icl:1"] {
            let m = registered_model(key).expect(key);
            assert_eq!(m.native_dims, 4096);
            assert!(m.native_dims <= EMBEDDING_WIDTH);
        }
    }

    #[test]
    fn non_mrl_models_are_excluded_from_the_prefix_index() {
        assert!(!registered_model("nvidia:NV-Embed-v2:1").unwrap().mrl_prefix_valid());
        assert!(!registered_model("baai:bge-en-icl:1").unwrap().mrl_prefix_valid());
        assert!(!registered_model("openai:text-embedding-ada-002:2").unwrap().mrl_prefix_valid());
        assert!(registered_model("openai:text-embedding-3-small:1").unwrap().mrl_prefix_valid());
    }
}
`;

/* ------------------------------------------------------------------ */
/* TypeScript + Dart                                                   */
/* ------------------------------------------------------------------ */

const ts = `// GENERATED FILE - do not edit by hand.
// Regenerate: node scripts/embeddings/generate.mjs
// Contract: ${C.contract} ${C.contractVersion} (sha256 ${CONTRACT_SHA})

export const EMBEDDING_WIDTH = ${W} as const;
export const EMBEDDING_PREFIX_WIDTH = ${PREFIX_DIMS} as const;
export const NORM_TOLERANCE = ${TOL} as const;
export const RRF_K = ${RRF_K} as const;

export type EmbeddingProvider = ${providers.map((x) => `'${x}'`).join(' | ')};
export type EmbeddingModelKey =
${models.map((m) => `  | '${m.key}'`).join('\n')};
export type EntityKind =
${kinds.map((k) => `  | '${k}'`).join('\n')};

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
${models
  .map(
    (m) =>
      `  { key: '${m.key}', provider: '${m.provider}', modelName: '${m.modelName}', modelVersion: '${m.modelVersion}', nativeDims: ${m.nativeDims}, mrl: ${m.mrl}, normalizedByProvider: ${m.normalizedByProvider}, family: '${m.family}' },`,
  )
  .join('\n')}
];

const BY_KEY = new Map(REGISTERED_MODELS.map((m) => [m.key, m]));

export const registeredModel = (key: string): RegisteredModel | undefined => BY_KEY.get(key as EmbeddingModelKey);

/**
 * Eligible for the halfvec(${PREFIX_DIMS}) prefix ANN index. A non-Matryoshka model is
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
 * L2-normalize, then right zero-pad to ${W}. This is the only supported way to
 * build a value for the embedding column: the database CHECK constraints assert
 * exactly these two properties and will reject anything else.
 *
 * Appending zeros leaves the norm - and therefore the cosine similarity and the
 * ranking - unchanged, which is what makes a ${1536}-component OpenAI vector safe to
 * store in a ${W}-wide slot alongside a ${4096}-component Qwen3 vector.
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
${kinds.map((k) => `  '${k}',`).join('\n')}
];
`;

const dart = `// GENERATED FILE - do not edit by hand.
// Regenerate: node scripts/embeddings/generate.mjs
// Contract: ${C.contract} ${C.contractVersion} (sha256 ${CONTRACT_SHA})

import 'dart:math' as math;
import 'dart:typed_data';

const int embeddingWidth = ${W};
const int embeddingPrefixWidth = ${PREFIX_DIMS};
const double normTolerance = ${TOL};
const int rrfK = ${RRF_K};

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

  /// Eligible for the halfvec(${PREFIX_DIMS}) prefix ANN index.
  bool get mrlPrefixValid => mrl && nativeDims >= embeddingPrefixWidth;
}

const List<RegisteredModel> registeredModels = <RegisteredModel>[
${models
  .map(
    (m) => `  RegisteredModel(
    key: '${m.key}',
    provider: '${m.provider}',
    modelName: '${m.modelName}',
    modelVersion: '${m.modelVersion}',
    nativeDims: ${m.nativeDims},
    mrl: ${m.mrl},
    normalizedByProvider: ${m.normalizedByProvider},
    family: '${m.family}',
  ),`,
  )
  .join('\n')}
];

final Map<String, RegisteredModel> _byKey = <String, RegisteredModel>{
  for (final RegisteredModel m in registeredModels) m.key: m,
};

RegisteredModel? registeredModel(String key) => _byKey[key];

const List<String> entityKinds = <String>[
${kinds.map((k) => `  '${k}',`).join('\n')}
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
`;

/* ------------------------------------------------------------------ */
/* Docs                                                                */
/* ------------------------------------------------------------------ */

const modelTable = models
  .map((m) => `| \`${m.key}\` | ${m.nativeDims} | ${m.mrl ? 'yes' : 'no'} | ${W - m.nativeDims} | ${m.notes} |`)
  .join('\n');

const docs = `<!-- GENERATED FILE - do not edit by hand.
     Regenerate: node scripts/embeddings/generate.mjs
     Contract: ${C.contract} ${C.contractVersion} (sha256 ${CONTRACT_SHA}) -->

# Embeddings in ${M.githubOrg}

${M.purpose}

Table: \`${T}\` · tenant column: \`${tenant}\` · owning repo: this one.

## Where the SQL lives, and why it lives here

The DDL and the migrations for this table are in **this repository**, under
\`db/schema/\` and \`db/migrations/\`. They are not assembled from
\`ORESoftware/k8s-libs-and-shared-defs\`. The org that owns the data owns the
schema that shapes it; the central repo keeps the federation boundary
invariants (no cross-org foreign keys, one owner per table) and nothing else.

\`dpm\` remains the only tool that applies any of it, apply still requires human
review, and no service runs DDL at boot.

## The ${W}-dimension decision

Every embedding is stored in a \`vector(${W})\` column: left-aligned to the model's
native width, zero on every index past it, and L2-normalized to unit length.

${W} is a fixed superset. It clears the widest models in use - Qwen3-Embedding-8B,
NVIDIA NV-Embed-v2, BAAI bge-en-icl and e5-mistral-7b-instruct are all 4096 - with
four slots of headroom, so adding a model does not mean a table rewrite.

The pad is free in the only sense that matters for retrieval: appending zeros
changes neither the L2 norm nor the cosine similarity, so an OpenAI
\`text-embedding-3-small\` vector with 1536 real components and ${W - 1536} zeros ranks
exactly as it would at its native width. It costs storage, and it costs a TOAST
read, and those are addressed below.

| model | native dims | Matryoshka | zeros stored | notes |
| --- | ---: | :---: | ---: | --- |
${modelTable}

**"Anthropic embeddings" means Voyage.** Anthropic does not publish a
first-party embedding model; Voyage AI is the embedding provider Anthropic
directs customers to, so the \`voyage\` provider in the registry is what fills
that slot. Registering it under its real name rather than under \`anthropic\`
keeps the model key honest about what actually produced the vector.

## The part that is easy to get wrong

**pgvector cannot index a ${W}-dimension vector column.** It can store up to
16000 dimensions, but HNSW and IVFFlat cap out at 2000 dimensions for the
\`vector\` type and 4000 for \`halfvec\`. A schema that declares \`vector(${W})\`
and then writes \`CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)\`
does not work - it fails at index creation.

So there is no index on the embedding column, and retrieval is two-stage:

1. **Candidates** come from a derived column that *is* indexable at ${W}.
   - \`embedding_bits\` — \`bit(${W})\`, the sign bits of the embedding, HNSW with
     \`bit_hamming_ops\`. Bit indexes go to 64000 dimensions. Hamming over sign
     bits is a valid coarse proxy for cosine on any unit-norm vector, so this
     surface works for **every** model. The zero pad quantizes to a constant run
     of zero bits, which adds the same constant to every pairwise distance
     inside a model group and leaves the ranking alone.
   - \`embedding_prefix\` — \`halfvec(${PREFIX_DIMS})\`, the leading ${PREFIX_DIMS} components,
     HNSW with \`halfvec_cosine_ops\`, **partial on \`mrl_prefix_valid\`**. Higher
     recall than the bit surface, but only valid for Matryoshka-trained models,
     where the leading components genuinely carry most of the information. For a
     non-MRL model like NV-Embed-v2 or bge-en-icl a prefix is an arbitrary
     coordinate subset and means nothing, which is why the index is partial
     rather than global.
2. **Exact rerank** computes \`embedding <=> $query\` on the candidate rows only.

That second stage is also what keeps the TOAST cost bounded. ${W} float32s is
${4 * W + 8} bytes, past the ~8160-byte in-page tuple budget, so the embedding column is
always out of line; the column is set to \`STORAGE EXTERNAL\` because float32
does not compress and paying pglz on every write and every detoast buys nothing.
Stage 1 reads only index pages. Stage 2 detoasts a few hundred rows.

## Never compare across models

Two vectors from different models occupy different spaces, and padding them to
the same width does not change that. Every generated query filters on
\`model_key\` before any distance operator is evaluated, every ANN index is
scoped by \`(${tenant}, model_key)\`, and \`${p}_emb_one_row_per_entity_per_model\`
lets one entity carry a row per model without the two ever being mixed.

## Hybrid, not vector-only

\`search_document\` is a stored \`tsvector\` built from three weighted sources -
\`title_text\` (A), \`summary_text\` (B), \`body_text\` (D) - with a GIN index. The
configuration is \`simple\` rather than a stemmer: these corpora are multilingual,
and a stemmer frozen into a STORED generated column cannot be changed later
without rewriting the table.

Lexical and vector results are combined by reciprocal rank fusion with k=${RRF_K},
not by adding the scores. \`ts_rank_cd\` and cosine distance are not on a
comparable scale, and normalizing them against each other would invent a
calibration nobody measured. RRF only needs the ranks.

## CockroachDB

\`db/schema/cockroach/\` carries the distributed variant. CockroachDB has no
pgvector, so neither derived surface exists there; it has C-SPANN instead, which
accelerates **L2 distance only**. That is survivable precisely because this
contract mandates unit-norm vectors: for unit vectors \`||a-b||² = 2 - 2·cos(a,b)\`,
so L2 ordering and cosine ordering are the same ordering. The normalization rule
is what makes one set of rows serve both engines.

Two operator notes: vector indexes are behind
\`SET CLUSTER SETTING feature.vector_index.enabled = true\`, and creating one on a
non-empty table blocks writes during backfill. The \`CREATE VECTOR INDEX\`
statement is therefore left commented out in the schema file and applied
deliberately.

## Prerequisites

| component | minimum | why |
| --- | --- | --- |
| pgvector | ${C.requires.pgvector} | \`halfvec\`, \`binary_quantize()\`, \`subvector()\`, \`l2_norm()\` and the \`bit_hamming_ops\` / \`halfvec_cosine_ops\` operator classes all landed in 0.7.0. On 0.6.x this schema fails to create - the types simply are not there. |
| PostgreSQL | ${C.requires.postgres} | STORED generated columns, \`gen_random_uuid()\`. |
| pgcrypto | migration only | \`digest()\` when backfilling \`content_sha256\`. |
| CockroachDB | ${C.requires.cockroachdb} | \`VECTOR\` and the C-SPANN index, plus \`feature.vector_index.enabled\`. |

\`\`\`sql
select extversion from pg_extension where extname = 'vector';  -- expect >= 0.7.0
\`\`\`

## Regenerating

\`\`\`bash
node scripts/embeddings/generate.mjs          # write
node scripts/embeddings/generate.mjs --check  # CI gate; fails on drift
node --test tests/embeddings-contract.test.mjs
\`\`\`

\`db/embedding-contract.json\` is vendored byte-identical into every org. Changing
it is a fleet change: regenerate in every org, or the checksum test fails.
`;

/* ------------------------------------------------------------------ */
/* Contract test                                                       */
/* ------------------------------------------------------------------ */

const test = `// GENERATED FILE - do not edit by hand.
// Regenerate: node scripts/embeddings/generate.mjs
//
// These assertions are the ones that would cost real money to get wrong: a
// dimension that does not fit, a pad that is not norm-preserving, an index that
// pgvector will refuse to create, or a model comparison that crosses spaces.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

const contractRaw = read('db/embedding-contract.json');
const contract = JSON.parse(contractRaw);
const pg = read('db/schema/postgres/0100_${p}_embeddings.sql');
const crdb = read('db/schema/cockroach/0100_${p}_embeddings.sql');

const W = ${W};
const PREFIX = ${PREFIX_DIMS};

test('the vendored contract has not drifted from the fleet copy', () => {
  assert.equal(
    createHash('sha256').update(contractRaw).digest('hex'),
    '${CONTRACT_SHA}',
    'db/embedding-contract.json differs from the fleet contract this repo was generated against. ' +
      'Re-vendor it and rerun the generator in every org rather than editing one copy.',
  );
});

test('the contract states the pgvector floor these types actually need', () => {
  // halfvec / binary_quantize / subvector / l2_norm / bit_hamming_ops are all
  // 0.7.0 features. A deployment on 0.6.x fails at CREATE TABLE, not at query
  // time, so the floor belongs in the contract and in the DDL header.
  assert.equal(contract.requires.pgvector, '>=0.7.0');
  assert.match(pg, /Requires pgvector >=0\.7\.0/);
});

test('every registered model fits the canonical width', () => {
  for (const m of contract.models) {
    assert.ok(m.nativeDims >= 1 && m.nativeDims <= W, \`\${m.key} is \${m.nativeDims}, outside 1..\${W}\`);
  }
});

test('the widest models we care about are covered with headroom', () => {
  const wide = contract.models.filter((m) => m.nativeDims === 4096).map((m) => m.key);
  for (const key of ['qwen:Qwen3-Embedding-8B:1', 'nvidia:NV-Embed-v2:1', 'baai:bge-en-icl:1']) {
    assert.ok(wide.includes(key), \`\${key} should be registered at 4096\`);
  }
  assert.ok(W > 4096, 'the canonical width must leave headroom past 4096');
});

test('the popular 1536-dimension models are stored with a zero tail', () => {
  const small = contract.models.find((m) => m.key === 'openai:text-embedding-3-small:1');
  assert.equal(small.nativeDims, 1536);
  assert.equal(W - small.nativeDims, ${W - 1536}, 'the OpenAI tail is the zero-padded remainder');
});

test('no ANN index is declared on the full-width vector column', () => {
  // pgvector caps HNSW/IVFFlat at 2000 dims for vector and 4000 for halfvec, so
  // an index on a vector(4100) column cannot be created at all. This test is the
  // guard against someone "fixing" the schema by adding one.
  assert.doesNotMatch(
    pg,
    /using\\s+hnsw\\s*\\(\\s*embedding\\s+/i,
    'an HNSW index directly on the embedding column would fail to create at ' + W + ' dimensions',
  );
  assert.doesNotMatch(pg, /using\\s+ivfflat\\s*\\(\\s*embedding\\s+/i);
});

test('both indexable candidate surfaces exist and are within their limits', () => {
  assert.match(pg, /embedding_bits\\s+bit\\(4100\\)/);
  assert.match(pg, /using hnsw \\(embedding_bits extensions\\.bit_hamming_ops\\)/);
  assert.ok(W <= 64000, 'bit indexes allow up to 64000 dimensions');

  assert.match(pg, /embedding_prefix\\s+extensions\\.halfvec\\(1024\\)/);
  assert.match(pg, /using hnsw \\(embedding_prefix extensions\\.halfvec_cosine_ops\\)/);
  assert.ok(PREFIX <= 4000, 'halfvec indexes allow up to 4000 dimensions');
});

test('the prefix index is partial, because a prefix is meaningless for a non-MRL model', () => {
  assert.match(pg, /using hnsw \\(embedding_prefix extensions\\.halfvec_cosine_ops\\)\\s*\\n\\s*where mrl_prefix_valid/);
  const nonMrl = contract.models.filter((m) => !m.mrl);
  assert.ok(nonMrl.length > 0, 'the registry should contain non-Matryoshka models');
  for (const m of nonMrl) {
    assert.equal(m.mrl, false);
  }
});

test('the zero-pad and unit-norm invariants are enforced by CHECK constraints', () => {
  assert.match(pg, /constraint ${p}_emb_zero_padded/);
  assert.match(pg, /constraint ${p}_emb_unit_norm/);
  assert.match(pg, /emb_is_zero_padded/);
  assert.match(pg, /emb_is_unit/);
});

test('full-text search sits alongside the vector, weighted and GIN-indexed', () => {
  assert.match(pg, /search_document\\s+tsvector generated always as/);
  assert.match(pg, /setweight\\(to_tsvector\\('simple', coalesce\\(title_text/);
  assert.match(pg, /using gin \\(search_document\\)/);
});

test('the embedding column is stored out of line without compression', () => {
  assert.match(pg, /alter column embedding set storage external/);
});

// The CockroachDB file explains in prose why pgvector's types are absent, so
// the assertions below run against the statements only, with -- comments and
// blank lines stripped. Asserting against the raw text would pass or fail on
// the wording of a comment rather than on the DDL.
const statementsOnly = (sql) =>
  sql
    .split('\\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\\n');

test('CockroachDB relies on L2, which unit norm makes equivalent to cosine', () => {
  const ddl = statementsOnly(crdb);
  assert.match(ddl, /vector\\(4100\\)/);
  assert.doesNotMatch(ddl, /halfvec/, 'CockroachDB has no halfvec type');
  assert.doesNotMatch(ddl, /binary_quantize/, 'CockroachDB has no binary_quantize()');
  assert.match(crdb, /vector_l2_ops/, 'the C-SPANN index, commented out, must be L2');
});

test('every query scopes by model before touching a distance operator', () => {
  for (const f of ['hybrid_search', 'dedupe_candidates', 'correlate_entities', 'alert_match']) {
    const q = read(\`db/queries/\${f}.sql\`);
    assert.match(q, /model_key/, \`\${f}.sql must scope by model_key\`);
  }
});
`;

/* ------------------------------------------------------------------ */
/* Emit                                                                */
/* ------------------------------------------------------------------ */

const outputs = new Map([
  [`db/schema/postgres/0100_${p}_embeddings.sql`, postgres],
  [`db/schema/cockroach/0100_${p}_embeddings.sql`, cockroach],
  [`db/migrations/${MIGRATION_VERSION}__${p}_embeddings_v2.sql`, migration],
  ['db/queries/hybrid_search.sql', hybridSearch],
  ['db/queries/dedupe_candidates.sql', dedupe],
  ['db/queries/correlate_entities.sql', correlate],
  ['db/queries/alert_match.sql', alertMatch],
  [`generated/rust/sea-orm/${tbl}.rs`, rust],
  ['generated/typescript/embeddings.ts', ts],
  ['generated/dart/embeddings.dart', dart],
  ['schema/embeddings.schema.json', JSON.stringify(jsonSchema, null, 2) + '\n'],
  ['typespec/embeddings.tsp', typespec],
  ['docs/embeddings.md', docs],
  ['tests/embeddings-contract.test.mjs', test],
]);

let stale = 0;
for (const [rel, content] of outputs) {
  const path = resolve(root, rel);
  if (CHECK) {
    const actual = await readFile(path, 'utf8').catch(() => null);
    if (actual !== content) {
      process.stderr.write(`stale: ${rel}\n`);
      stale += 1;
    }
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

if (CHECK && stale > 0) {
  process.stderr.write(`\n${stale} generated file(s) differ. Run: node scripts/embeddings/generate.mjs\n`);
  process.exit(1);
}

process.stdout.write(
  CHECK
    ? `embeddings contract ${C.contractVersion}: ${outputs.size} generated files are current\n`
    : `embeddings contract ${C.contractVersion}: wrote ${outputs.size} files for ${M.githubOrg} (${T})\n`,
);
