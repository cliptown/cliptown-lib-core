import fs from 'node:fs';
const read = p => fs.readFileSync(p, 'utf8');
const registry = JSON.parse(read('embedding-contract/model-space-v3.json'));
const schema = JSON.parse(read('embedding-contract/model-space-v3.schema.json'));
const tsp = read('embedding-contract/model-space-v3.tsp');
const pg = read('embedding-contract/sql/postgres/desired-v3.sql');
const hybrid = read('embedding-contract/sql/postgres/hybrid-search-v3-exact.sql');
const crdb = read('embedding-contract/sql/cockroachdb/desired-v3.sql');
const fail = message => { throw new Error(message); };
if (registry.contractVersion !== '3.1.0' || registry.storage.slots !== 4100) fail('version/storage drift');
if (!registry.providers.embedding.includes('voyage') || registry.providers.embedding.includes('anthropic')) fail('provider provenance drift');
if (!registry.providers.generation.includes('anthropic')) fail('generation provenance drift');
if (registry.database.globalFilteredAnnIndex !== false || registry.database.fusion !== 'reciprocal-rank-fusion') fail('search policy drift');
if (JSON.stringify(registry.purposes) !== JSON.stringify(['clip_search', 'clip_deduplication', 'discovery'])) fail('purpose drift');
for (const token of ['tenant_id,embedding_id,space_key,purpose,input_role', 'current_tenant_id_v3', 'embedding_is_valid_v3', 'ENABLE ROW LEVEL SECURITY', 'voyage', 'DEFAULT FALSE']) {
  if (!pg.includes(token)) fail(`postgres missing ${token}`);
}
for (const token of ['semantic_candidates', 'lexical_candidates', 'UNION', 'fusion_k', 'SECURITY INVOKER']) {
  if (!hybrid.includes(token)) fail(`hybrid missing ${token}`);
}
if (/USING\s+hnsw/i.test(pg)) fail('global ANN index forbidden before recall evidence');
for (const token of ['VECTOR(4100)', 'voyage', 'CREATE VECTOR INDEX ...']) {
  if (!crdb.includes(token)) fail(`cockroach declaration missing ${token}`);
}
if (!tsp.includes('Voyage:"voyage"') || !tsp.includes('storageDimensions: 4100')) fail('TypeSpec drift');
if (schema.properties.product.const !== 'cliptown') fail('schema product drift');
console.log('ClipTown embedding model-space v3 contract verified');
