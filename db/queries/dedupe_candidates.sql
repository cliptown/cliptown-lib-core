-- GENERATED FILE - do not edit by hand.
-- Near-duplicate detection for cliptown.clip_embeddings. 
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

-- Bind parameters:
--   $1  account_id (uuid)
--   $2  model_key (text)
--   $3  candidate embedding (vector(4100), unit norm, zero-padded)
--   $4  content_sha256 (text) - exact-match short circuit
--   $5  cosine similarity threshold (double precision) - 0.95 is a reasonable start
--   $6  candidate count (int)
--
-- Requires search_path to include the extensions schema, or the caller must
-- schema-qualify the distance operators.

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
         greatest(coalesce($6::int, 400), 1) as candidates
),
exact_match as (
  select e.id, e.entity_kind, e.entity_id, 1.0::double precision as similarity,
         'content_sha256'::text as match_kind
    from cliptown.clip_embeddings e, scope s
   where e.account_id = s.tenant
     and e.model_key = s.model_key
     and e.content_sha256 = s.sha
),
candidates as (
  select e.id
    from cliptown.clip_embeddings e, scope s
   where e.account_id = s.tenant
     and e.model_key = s.model_key
   order by case
     when e.mrl_prefix_valid
       then e.embedding_prefix <=> extensions.subvector(s.qv, 1, 1024)::extensions.halfvec(1024)
     else (e.embedding_bits <~> extensions.binary_quantize(s.qv)::bit(4100))::double precision
   end
   limit (select candidates from scope)
),
semantic_match as (
  select e.id, e.entity_kind, e.entity_id,
         1 - (e.embedding <=> (select qv from scope)) as similarity,
         'cosine'::text as match_kind
    from candidates c
    join cliptown.clip_embeddings e on e.id = c.id
   where 1 - (e.embedding <=> (select qv from scope)) >= (select threshold from scope)
)
select * from exact_match
union
select * from semantic_match
order by similarity desc, id
limit 50;
