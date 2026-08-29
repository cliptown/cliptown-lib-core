-- GENERATED FILE - do not edit by hand.
-- Hybrid retrieval over cliptown.clip_embeddings: lexical + vector, fused by reciprocal rank.
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

-- Bind parameters:
--   $1  account_id (uuid)
--   $2  model_key (text) - the model the query vector came from; never mixed
--   $3  query embedding (vector(4100), unit norm, zero-padded)
--   $4  query text (text) - websearch syntax
--   $5  candidate count (int) - stage-1 fan-out, contract default 400
--   $6  result count (int) - contract default 20
--   $7  entity kinds (text[]) - null or empty means all kinds
--
-- Requires search_path to include the extensions schema, or the caller must
-- schema-qualify the distance operators.

-- Stage 1a: vector candidates. Sourced from the prefix index when the model is
-- Matryoshka, and from the bit index otherwise. Both are indexable at 4100
-- dimensions; the embedding column itself is not.
-- Stage 1b: lexical candidates from the GIN index.
-- Stage 2:  exact cosine on the union, which is the only place the full-width
--           vector is detoasted - a few hundred rows, not the table.
-- Stage 3:  reciprocal rank fusion, k=60. RRF is used because ts_rank_cd and
--           cosine distance are not on a comparable scale and normalizing them
--           against each other invents a calibration we do not have.

with scope as (
  select $1::uuid as tenant, $2::text as model_key,
         $3::extensions.vector as qv, $4::text as q,
         greatest(coalesce($5::int, 400), 1) as candidates,
         greatest(coalesce($6::int, 20), 1) as results,
         $7::text[] as kinds
),
vector_candidates as (
  select e.id,
         row_number() over (
           order by case
             when e.mrl_prefix_valid
               then e.embedding_prefix <=> extensions.subvector(s.qv, 1, 1024)::extensions.halfvec(1024)
             else (e.embedding_bits <~> extensions.binary_quantize(s.qv)::bit(4100))::double precision
           end
         ) as rank
    from cliptown.clip_embeddings e, scope s
   where e.account_id = s.tenant
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
    from cliptown.clip_embeddings e, scope s
   where e.account_id = s.tenant
     and s.q is not null and s.q <> ''
     and e.search_document @@ websearch_to_tsquery('simple', s.q)
     and (s.kinds is null or cardinality(s.kinds) = 0 or e.entity_kind = any (s.kinds))
   order by rank
   limit (select candidates from scope)
),
fused as (
  select coalesce(v.id, l.id) as id,
         coalesce(1.0 / (60 + v.rank), 0.0) + coalesce(1.0 / (60 + l.rank), 0.0) as rrf_score,
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
  join cliptown.clip_embeddings e on e.id = f.id
 order by f.rrf_score desc, cosine_similarity desc nulls last, e.id
 limit (select results from scope);
