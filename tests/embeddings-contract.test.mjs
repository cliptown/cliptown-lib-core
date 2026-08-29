// GENERATED FILE - do not edit by hand.
// Regenerate: node scripts/embeddings/generate.mjs
//
// These assertions are the ones that would cost real money to get wrong: a
// dimension that does not fit, a pad that is not norm-preserving, an index that
// pgvector will refuse to create, or a model comparison that crosses spaces.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

const contractRaw = read('db/embedding-contract.json');
const contract = JSON.parse(contractRaw);
const pg = read('db/schema/postgres/0100_cliptown_embeddings.sql');
const crdb = read('db/schema/cockroach/0100_cliptown_embeddings.sql');

const W = 4100;
const PREFIX = 1024;

test('the vendored contract has not drifted from the fleet copy', () => {
  assert.equal(
    createHash('sha256').update(contractRaw).digest('hex'),
    '98976465928699fb3c6c20728e4ad9f42a9d4ba0a626332f9184317c77c1e844',
    'db/embedding-contract.json differs from the fleet contract this repo was generated against. ' +
      'Re-vendor it and rerun the generator in every org rather than editing one copy.',
  );
});

test('the contract states the pgvector floor these types actually need', () => {
  // halfvec / binary_quantize / subvector / l2_norm / bit_hamming_ops are all
  // 0.7.0 features. A deployment on 0.6.x fails at CREATE TABLE, not at query
  // time, so the floor belongs in the contract and in the DDL header.
  assert.equal(contract.requires.pgvector, '>=0.7.0');
  assert.match(pg, /Requires pgvector >=0.7.0/);
});

test('every registered model fits the canonical width', () => {
  for (const m of contract.models) {
    assert.ok(m.nativeDims >= 1 && m.nativeDims <= W, `${m.key} is ${m.nativeDims}, outside 1..${W}`);
  }
});

test('the widest models we care about are covered with headroom', () => {
  const wide = contract.models.filter((m) => m.nativeDims === 4096).map((m) => m.key);
  for (const key of ['qwen:Qwen3-Embedding-8B:1', 'nvidia:NV-Embed-v2:1', 'baai:bge-en-icl:1']) {
    assert.ok(wide.includes(key), `${key} should be registered at 4096`);
  }
  assert.ok(W > 4096, 'the canonical width must leave headroom past 4096');
});

test('the popular 1536-dimension models are stored with a zero tail', () => {
  const small = contract.models.find((m) => m.key === 'openai:text-embedding-3-small:1');
  assert.equal(small.nativeDims, 1536);
  assert.equal(W - small.nativeDims, 2564, 'the OpenAI tail is the zero-padded remainder');
});

test('no ANN index is declared on the full-width vector column', () => {
  // pgvector caps HNSW/IVFFlat at 2000 dims for vector and 4000 for halfvec, so
  // an index on a vector(4100) column cannot be created at all. This test is the
  // guard against someone "fixing" the schema by adding one.
  assert.doesNotMatch(
    pg,
    /using\s+hnsw\s*\(\s*embedding\s+/i,
    'an HNSW index directly on the embedding column would fail to create at ' + W + ' dimensions',
  );
  assert.doesNotMatch(pg, /using\s+ivfflat\s*\(\s*embedding\s+/i);
});

test('both indexable candidate surfaces exist and are within their limits', () => {
  assert.match(pg, /embedding_bits\s+bit\(4100\)/);
  assert.match(pg, /using hnsw \(embedding_bits extensions\.bit_hamming_ops\)/);
  assert.ok(W <= 64000, 'bit indexes allow up to 64000 dimensions');

  assert.match(pg, /embedding_prefix\s+extensions\.halfvec\(1024\)/);
  assert.match(pg, /using hnsw \(embedding_prefix extensions\.halfvec_cosine_ops\)/);
  assert.ok(PREFIX <= 4000, 'halfvec indexes allow up to 4000 dimensions');
});

test('the prefix index is partial, because a prefix is meaningless for a non-MRL model', () => {
  assert.match(pg, /using hnsw \(embedding_prefix extensions\.halfvec_cosine_ops\)\s*\n\s*where mrl_prefix_valid/);
  const nonMrl = contract.models.filter((m) => !m.mrl);
  assert.ok(nonMrl.length > 0, 'the registry should contain non-Matryoshka models');
  for (const m of nonMrl) {
    assert.equal(m.mrl, false);
  }
});

test('the zero-pad and unit-norm invariants are enforced by CHECK constraints', () => {
  assert.match(pg, /constraint cliptown_emb_zero_padded/);
  assert.match(pg, /constraint cliptown_emb_unit_norm/);
  assert.match(pg, /emb_is_zero_padded/);
  assert.match(pg, /emb_is_unit/);
});

test('full-text search sits alongside the vector, weighted and GIN-indexed', () => {
  assert.match(pg, /search_document\s+tsvector generated always as/);
  assert.match(pg, /setweight\(to_tsvector\('simple', coalesce\(title_text/);
  assert.match(pg, /using gin \(search_document\)/);
});

test('the embedding column is stored out of line without compression', () => {
  assert.match(pg, /alter column embedding set storage external/);
});

// The CockroachDB file explains in prose why pgvector's types are absent, so
// the assertions below run against the statements only, with -- comments and
// blank lines stripped. Asserting against the raw text would pass or fail on
// the wording of a comment rather than on the DDL.
const statementsOnly = (sql) =>
  sql
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');

test('CockroachDB relies on L2, which unit norm makes equivalent to cosine', () => {
  const ddl = statementsOnly(crdb);
  assert.match(ddl, /vector\(4100\)/);
  assert.doesNotMatch(ddl, /halfvec/, 'CockroachDB has no halfvec type');
  assert.doesNotMatch(ddl, /binary_quantize/, 'CockroachDB has no binary_quantize()');
  assert.match(crdb, /vector_l2_ops/, 'the C-SPANN index, commented out, must be L2');
});

test('every query scopes by model before touching a distance operator', () => {
  for (const f of ['hybrid_search', 'dedupe_candidates', 'correlate_entities', 'alert_match']) {
    const q = read(`db/queries/${f}.sql`);
    assert.match(q, /model_key/, `${f}.sql must scope by model_key`);
  }
});
