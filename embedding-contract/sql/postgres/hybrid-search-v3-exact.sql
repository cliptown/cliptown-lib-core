-- Independent lexical/vector candidates with reciprocal-rank fusion.
CREATE OR REPLACE FUNCTION cliptown.hybrid_search_v3_exact(
  p_space_key TEXT, p_purpose TEXT, p_query_embedding VECTOR(4100),
  p_query_text TEXT, p_requested_limit INTEGER, p_query_role TEXT, p_document_role TEXT
) RETURNS TABLE(embedding_id UUID, entity_kind TEXT, entity_id TEXT,
  semantic_score DOUBLE PRECISION, semantic_rank INTEGER, lexical_rank INTEGER, fused_score DOUBLE PRECISION)
LANGUAGE SQL STABLE SECURITY INVOKER
SET search_path = cliptown, public, pg_temp AS $$
WITH selected_space AS MATERIALIZED (
  SELECT * FROM cliptown.embedding_comparison_spaces_v3
  WHERE space_key=p_space_key AND purpose=p_purpose AND query_role=p_query_role
    AND document_role=p_document_role AND distance_metric='cosine' AND exact_rerank AND enabled
    AND cliptown.embedding_is_valid_v3(p_query_embedding,source_dimensions)
), semantic_candidates AS MATERIALIZED (
  SELECT e.embedding_id,
    row_number() OVER(ORDER BY e.embedding OPERATOR(public.<=>) p_query_embedding,e.embedding_id)::INTEGER semantic_rank
  FROM cliptown.semantic_embeddings_v3 e JOIN selected_space s
    ON e.space_key=s.space_key AND e.purpose=s.purpose
   AND e.profile_key=s.document_profile_key AND e.input_role=s.document_role
   AND e.source_dimensions=s.source_dimensions
  WHERE e.tenant_id=cliptown.current_tenant_id_v3() AND (e.expires_at IS NULL OR e.expires_at>now())
  ORDER BY e.embedding OPERATOR(public.<=>) p_query_embedding,e.embedding_id
  LIMIT COALESCE((SELECT LEAST(semantic_candidate_limit::INTEGER,GREATEST(p_requested_limit*20,100)) FROM selected_space),0)
), lexical_candidates AS MATERIALIZED (
  SELECT e.embedding_id,
    row_number() OVER(ORDER BY ts_rank_cd(e.search_document,websearch_to_tsquery('simple',p_query_text)) DESC,e.embedding_id)::INTEGER lexical_rank
  FROM cliptown.semantic_embeddings_v3 e JOIN selected_space s
    ON e.space_key=s.space_key AND e.purpose=s.purpose
   AND e.profile_key=s.document_profile_key AND e.input_role=s.document_role
   AND e.source_dimensions=s.source_dimensions
  WHERE e.tenant_id=cliptown.current_tenant_id_v3() AND btrim(p_query_text)<>''
    AND e.search_document@@websearch_to_tsquery('simple',p_query_text)
    AND (e.expires_at IS NULL OR e.expires_at>now())
  ORDER BY ts_rank_cd(e.search_document,websearch_to_tsquery('simple',p_query_text)) DESC,e.embedding_id
  LIMIT COALESCE((SELECT LEAST(lexical_candidate_limit::INTEGER,GREATEST(p_requested_limit*20,100)) FROM selected_space),0)
), candidate_ids AS (
  SELECT embedding_id FROM semantic_candidates UNION SELECT embedding_id FROM lexical_candidates
), scored AS (
  SELECT e.embedding_id,e.entity_kind,e.entity_id,
    1-(e.embedding OPERATOR(public.<=>) p_query_embedding) semantic_score,
    sem.semantic_rank,lex.lexical_rank,
    COALESCE(1.0/((SELECT fusion_k FROM selected_space)::DOUBLE PRECISION+sem.semantic_rank),0.0)
      +COALESCE(1.0/((SELECT fusion_k FROM selected_space)::DOUBLE PRECISION+lex.lexical_rank),0.0) fused_score
  FROM candidate_ids c JOIN cliptown.semantic_embeddings_v3 e USING(embedding_id)
  LEFT JOIN semantic_candidates sem USING(embedding_id)
  LEFT JOIN lexical_candidates lex USING(embedding_id)
  WHERE e.tenant_id=cliptown.current_tenant_id_v3()
)
SELECT * FROM scored ORDER BY fused_score DESC,semantic_score DESC,embedding_id
LIMIT COALESCE((SELECT LEAST(result_limit::INTEGER,GREATEST(p_requested_limit,1)) FROM selected_space),0)
$$;
