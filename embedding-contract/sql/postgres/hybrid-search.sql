-- Parameters: $1 tenant UUID, $2 padded vector(4100), $3 lexical text,
-- $4 purpose, $5 result limit, $6 embedding-space identity.
-- Tenant/purpose/space filtering occurs before ANN; unlike embedding spaces are never compared.
WITH binary_candidates AS MATERIALIZED (
  SELECT
    embedding_id,
    entity_kind,
    entity_id,
    search_document,
    embedding,
    binary_quantize(embedding)::bit(4100) <~>
      binary_quantize($2::vector(4100))::bit(4100) AS hamming_distance
  FROM cliptown.semantic_embeddings
  WHERE tenant_id = $1::UUID
    AND purpose = $4::TEXT
    AND embedding_space = $6::TEXT
    AND (expires_at IS NULL OR expires_at > now())
  ORDER BY binary_quantize(embedding)::bit(4100) <~>
    binary_quantize($2::vector(4100))::bit(4100)
  LIMIT LEAST(GREATEST($5::INT * 20, 100), 4000)
), exact_rerank AS (
  SELECT
    embedding_id,
    entity_kind,
    entity_id,
    hamming_distance,
    1 - (embedding <=> $2::vector(4100)) AS semantic_score,
    CASE WHEN btrim($3::TEXT) = '' THEN 0
      ELSE ts_rank_cd(search_document, websearch_to_tsquery('simple', $3::TEXT))
    END AS lexical_score
  FROM binary_candidates
)
SELECT
  embedding_id,
  entity_kind,
  entity_id,
  semantic_score,
  lexical_score,
  (semantic_score * 0.75) + (least(lexical_score, 1) * 0.25) AS combined_score
FROM exact_rerank
ORDER BY combined_score DESC, hamming_distance ASC, embedding_id ASC
LIMIT LEAST(GREATEST($5::INT, 1), 200);
