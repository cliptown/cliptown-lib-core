-- CockroachDB exact-baseline hybrid query template.
-- Parameters: $1 tenant UUID, $2 space key, $3 purpose, $4 VECTOR(4100), $5 text, $6 limit, $7 query role, $8 document role.
WITH selected_space AS (
 SELECT * FROM cliptown.embedding_comparison_spaces_v3 WHERE space_key=$2 AND purpose=$3 AND query_role=$7 AND document_role=$8 AND enabled AND exact_rerank
), semantic_candidates AS (
 SELECT e.embedding_id,row_number() OVER(ORDER BY cosine_distance(e.embedding,$4),e.embedding_id) AS semantic_rank
 FROM cliptown.semantic_embeddings_v3 e JOIN selected_space s ON e.space_key=s.space_key AND e.profile_key=s.document_profile_key AND e.input_role=s.document_role
 WHERE e.tenant_id=$1 AND (e.expires_at IS NULL OR e.expires_at>now()) ORDER BY cosine_distance(e.embedding,$4),e.embedding_id LIMIT 4000
), lexical_candidates AS (
 SELECT e.embedding_id,row_number() OVER(ORDER BY ts_rank(e.search_document,websearch_to_tsquery('simple',$5)) DESC,e.embedding_id) AS lexical_rank
 FROM cliptown.semantic_embeddings_v3 e JOIN selected_space s ON e.space_key=s.space_key AND e.profile_key=s.document_profile_key AND e.input_role=s.document_role
 WHERE e.tenant_id=$1 AND btrim($5)<>'' AND e.search_document@@websearch_to_tsquery('simple',$5) LIMIT 4000
), ids AS (SELECT embedding_id FROM semantic_candidates UNION SELECT embedding_id FROM lexical_candidates)
SELECT e.embedding_id,e.entity_kind,e.entity_id,1-cosine_distance(e.embedding,$4) AS semantic_score,
 sem.semantic_rank,lex.lexical_rank,
 coalesce(1.0/(60+sem.semantic_rank),0.0)+coalesce(1.0/(60+lex.lexical_rank),0.0) AS fused_score
FROM ids JOIN cliptown.semantic_embeddings_v3 e USING(embedding_id)
LEFT JOIN semantic_candidates sem USING(embedding_id) LEFT JOIN lexical_candidates lex USING(embedding_id)
WHERE e.tenant_id=$1 ORDER BY fused_score DESC,semantic_score DESC,e.embedding_id LIMIT $6;
