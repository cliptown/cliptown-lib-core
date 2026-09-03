BEGIN;
INSERT INTO cliptown.embedding_generation_profiles_v3(profile_key,embedding_provider,model,model_revision,source_dimensions,normalization,task_profile,instruction_family,instruction_sha256,preprocessing_sha256,input_role,modality,distance_metric,ann_strategy,ann_dimensions,supports_mrl,enabled)
VALUES
 ('cliptown:test:query','openai','text-embedding-3-small','test',2,'provider','test','default',repeat('0',64),repeat('1',64),'query','text','cosine','exact-only',0,false,true),
 ('cliptown:test:document','openai','text-embedding-3-small','test',2,'provider','test','default',repeat('0',64),repeat('1',64),'document','text','cosine','exact-only',0,false,true);
INSERT INTO cliptown.embedding_comparison_spaces_v3(space_key,purpose,query_profile_key,query_role,document_profile_key,document_role,source_dimensions,distance_metric,lexical_candidate_limit,semantic_candidate_limit,result_limit,fusion_k,enabled)
VALUES('cliptown:test:space:v3','clip_search','cliptown:test:query','query','cliptown:test:document','document',2,'cosine',100,100,25,60,true);
SET LOCAL app.tenant_id='00000000-0000-4000-8000-000000000001';
INSERT INTO cliptown.semantic_embeddings_v3(embedding_id,tenant_id,entity_kind,entity_id,purpose,profile_key,input_role,space_key,query_profile_key,query_role,document_profile_key,document_role,source_dimensions,distance_metric,embedding,title_text,content_sha256,source_revision)
VALUES
 ('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000001','item','query','clip_search','cliptown:test:query','query','cliptown:test:space:v3','cliptown:test:query','query','cliptown:test:document','document',2,'cosine',cliptown.pad_embedding_v3(ARRAY[1.0::REAL,0.0::REAL]),'query',repeat('a',64),'1'),
 ('00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000001','item','lexical-only','clip_search','cliptown:test:document','document','cliptown:test:space:v3','cliptown:test:query','query','cliptown:test:document','document',2,'cosine',cliptown.pad_embedding_v3(ARRAY[0.0::REAL,1.0::REAL]),'rare exact phrase',repeat('b',64),'1');
DO $$ BEGIN
  BEGIN
    INSERT INTO cliptown.semantic_embeddings_v3(tenant_id,entity_kind,entity_id,purpose,profile_key,input_role,space_key,query_profile_key,query_role,document_profile_key,document_role,source_dimensions,distance_metric,embedding,content_sha256,source_revision)
    VALUES('00000000-0000-4000-8000-000000000001','item','bad-tail','clip_search','cliptown:test:document','document','cliptown:test:space:v3','cliptown:test:query','query','cliptown:test:document','document',2,'cosine',cliptown.pad_embedding_v3(ARRAY[1.0::REAL,0.0::REAL,0.25::REAL]),repeat('c',64),'1');
    RAISE EXCEPTION 'non-zero tail unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
DO $$ DECLARE found UUID; BEGIN
  SELECT embedding_id INTO found FROM cliptown.hybrid_search_v3_exact('cliptown:test:space:v3','clip_search',cliptown.pad_embedding_v3(ARRAY[1.0::REAL,0.0::REAL]),'rare exact phrase',10,'query','document') WHERE entity_id='lexical-only';
  IF found IS NULL THEN RAISE EXCEPTION 'lexical-only candidate missing'; END IF;
END $$;
SET LOCAL app.tenant_id='00000000-0000-4000-8000-000000000002';
INSERT INTO cliptown.semantic_embeddings_v3(embedding_id,tenant_id,entity_kind,entity_id,purpose,profile_key,input_role,space_key,query_profile_key,query_role,document_profile_key,document_role,source_dimensions,distance_metric,embedding,content_sha256,source_revision)
VALUES('00000000-0000-4000-8000-000000000202','00000000-0000-4000-8000-000000000002','item','other-tenant','clip_search','cliptown:test:document','document','cliptown:test:space:v3','cliptown:test:query','query','cliptown:test:document','document',2,'cosine',cliptown.pad_embedding_v3(ARRAY[0.0::REAL,1.0::REAL]),repeat('d',64),'1');
SET LOCAL app.tenant_id='00000000-0000-4000-8000-000000000001';
DO $$ BEGIN
  BEGIN
    INSERT INTO cliptown.semantic_match_events_v3(tenant_id,space_key,purpose,source_embedding_id,source_input_role,candidate_embedding_id,candidate_input_role,semantic_score,fused_score,disposition,notification_dedupe_key)
    VALUES('00000000-0000-4000-8000-000000000001','cliptown:test:space:v3','clip_search','00000000-0000-4000-8000-000000000101','query','00000000-0000-4000-8000-000000000202','document',0.5,0.1,'candidate','tenant-boundary-test-key');
    RAISE EXCEPTION 'cross-tenant reference unexpectedly accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END $$;
SET LOCAL app.tenant_id='malformed';
DO $$ BEGIN IF cliptown.current_tenant_id_v3() IS NOT NULL THEN RAISE EXCEPTION 'malformed tenant accepted'; END IF; END $$;
ROLLBACK;
