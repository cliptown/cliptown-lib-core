-- GENERATED FILE - do not edit by hand.
-- Cross-kind correlation for cliptown.clip_embeddings: given one row, the rows of other kinds that are closest to it.
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
--   $2  source row id (uuid)
--   $3  target entity kinds (text[])
--   $4  minimum cosine similarity (double precision)
--   $5  result count (int)
--
-- Requires search_path to include the extensions schema, or the caller must
-- schema-qualify the distance operators.

-- Correlation is the same machinery as search with the query vector read from
-- a stored row instead of computed from text, and with the source row's own
-- kind excluded so a claim correlates against evidence rather than against
-- other claims. The model_key is taken from the source row, which is what
-- keeps the comparison inside one vector space.

with src as (
  select e.id, e.account_id as tenant, e.model_key, e.embedding, e.embedding_bits,
         e.embedding_prefix, e.mrl_prefix_valid, e.entity_kind
    from cliptown.clip_embeddings e
   where e.id = $2::uuid and e.account_id = $1::uuid
),
candidates as (
  select t.id
    from cliptown.clip_embeddings t, src
   where t.account_id = src.tenant
     and t.model_key = src.model_key
     and t.id <> src.id
     and ($3::text[] is null or cardinality($3::text[]) = 0 or t.entity_kind = any ($3::text[]))
   order by case
     when src.mrl_prefix_valid then t.embedding_prefix <=> src.embedding_prefix
     else (t.embedding_bits <~> src.embedding_bits)::double precision
   end
   limit 400
)
select t.id, t.entity_kind, t.entity_id, t.title_text, t.summary_text, t.metadata,
       1 - (t.embedding <=> src.embedding) as cosine_similarity
  from candidates c
  join cliptown.clip_embeddings t on t.id = c.id
  cross join src
 where 1 - (t.embedding <=> src.embedding) >= coalesce($4::double precision, 0.7)
 order by cosine_similarity desc, t.id
 limit greatest(coalesce($5::int, 20), 1);
