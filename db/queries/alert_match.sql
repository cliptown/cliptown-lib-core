-- GENERATED FILE - do not edit by hand.
-- Alert matching for cliptown.clip_embeddings: which saved alert rules does a newly ingested row fire?
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
--   $2  newly ingested row id (uuid)
--   $3  default cosine threshold (double precision) - overridden per rule via metadata
--
-- Requires search_path to include the extensions schema, or the caller must
-- schema-qualify the distance operators.

-- An alert rule is itself a row in this table, with entity_kind = 'alert_rule'
-- and its threshold in metadata->>'threshold'. Matching a new document against
-- every rule is therefore the same nearest-neighbour question as everything
-- else here, evaluated in the direction rule <- document.
--
-- Per-rule thresholds live in metadata rather than in a column because they are
-- a property of the rule the user wrote, not of the embedding, and because a
-- rule with no explicit threshold should inherit the caller's default.

with doc as (
  select e.id, e.account_id as tenant, e.model_key, e.embedding, e.embedding_bits,
         e.embedding_prefix, e.mrl_prefix_valid, e.entity_kind, e.title_text
    from cliptown.clip_embeddings e
   where e.id = $2::uuid and e.account_id = $1::uuid
),
rule_candidates as (
  select r.id
    from cliptown.clip_embeddings r, doc
   where r.account_id = doc.tenant
     and r.model_key = doc.model_key
     and r.entity_kind = 'alert_rule'
   order by case
     when doc.mrl_prefix_valid then r.embedding_prefix <=> doc.embedding_prefix
     else (r.embedding_bits <~> doc.embedding_bits)::double precision
   end
   limit 400
)
select r.id as rule_id,
       r.entity_id as rule_entity_id,
       r.title_text as rule_title,
       doc.id as matched_row_id,
       doc.title_text as matched_title,
       1 - (r.embedding <=> doc.embedding) as cosine_similarity,
       coalesce((r.metadata->>'threshold')::double precision, $3::double precision, 0.78) as threshold_applied
  from rule_candidates c
  join cliptown.clip_embeddings r on r.id = c.id
  cross join doc
 where 1 - (r.embedding <=> doc.embedding)
       >= coalesce((r.metadata->>'threshold')::double precision, $3::double precision, 0.78)
 order by cosine_similarity desc, r.id;
