-- Parameters: $1 tenant UUID, $2 padded VECTOR(4100), $3 lexical text,
-- $4 purpose, $5 result limit, $6 embedding-space identity.
-- Tenant, space, and purpose are C-SPANN prefix columns; unlike spaces are never compared.
WITH vector_candidates AS MATERIALIZED (
  SELECT
    embedding_id,
    entity_kind,
    entity_id,
    1 - (embedding <=> $2::VECTOR(4100)) AS semantic_score,
    CASE
      WHEN btrim($3::STRING) = '' THEN 0.0::FLOAT8
      WHEN search_document @@ plainto_tsquery('simple', $3::STRING) THEN 1.0::FLOAT8
      ELSE 0.0::FLOAT8
    END AS lexical_score
  FROM cliptown.semantic_embeddings
  WHERE tenant_id = $1::UUID
    AND purpose = $4::STRING
    AND embedding_space = $6::STRING
    AND (expires_at IS NULL OR expires_at > now())
  ORDER BY embedding <=> $2::VECTOR(4100)
  LIMIT LEAST(GREATEST($5::INT * 20, 100), 4000)
)
SELECT
  embedding_id,
  entity_kind,
  entity_id,
  semantic_score,
  lexical_score,
  (semantic_score * 0.75) + (lexical_score * 0.25) AS combined_score
FROM vector_candidates
ORDER BY combined_score DESC, embedding_id ASC
LIMIT LEAST(GREATEST($5::INT, 1), 200);
