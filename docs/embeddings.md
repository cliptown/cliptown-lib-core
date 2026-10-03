<!-- GENERATED FILE - do not edit by hand.
     Regenerate: node scripts/embeddings/generate.mjs
     Contract: ores-embedding-contract 2026.08.29 (sha256 98976465928699fb3c6c20728e4ad9f42a9d4ba0a626332f9184317c77c1e844) -->

# Embeddings in cliptown

Semantic recall over clipboard history: find the thing you copied three weeks ago from a description of it rather than its exact text.

Table: `cliptown.clip_embeddings` · tenant column: `account_id` · owning repo: this one.

## Where the SQL lives, and why it lives here

The DDL and the migrations for this table are in **this repository**, under
`db/schema/` and `db/migrations/`. They are not assembled from
`ORESoftware/k8s-libs-and-shared-defs`. The org that owns the data owns the
schema that shapes it; the central repo keeps the federation boundary
invariants (no cross-org foreign keys, one owner per table) and nothing else.

`dpm` remains the only tool that applies any of it, apply still requires human
review, and no service runs DDL at boot.

## The 4100-dimension decision

Every embedding is stored in a `vector(4100)` column: left-aligned to the model's
native width, zero on every index past it, and L2-normalized to unit length.

4100 is a fixed superset. It clears the widest models in use - Qwen3-Embedding-8B,
NVIDIA NV-Embed-v2, BAAI bge-en-icl and e5-mistral-7b-instruct are all 4096 - with
four slots of headroom, so adding a model does not mean a table rewrite.

The pad is free in the only sense that matters for retrieval: appending zeros
changes neither the L2 norm nor the cosine similarity, so an OpenAI
`text-embedding-3-small` vector with 1536 real components and 2564 zeros ranks
exactly as it would at its native width. It costs storage, and it costs a TOAST
read, and those are addressed below.

| model | native dims | Matryoshka | zeros stored | notes |
| --- | ---: | :---: | ---: | --- |
| `openai:text-embedding-3-large:1` | 3072 | yes | 1028 | Matryoshka; can be requested shortened via the dimensions parameter. Store whatever width was requested in native_dims and zero-pad the rest. |
| `openai:text-embedding-3-small:1` | 1536 | yes | 2564 | 1536 max/default; shortenable. The common case: 1536 real components followed by 2564 zeros. |
| `openai:text-embedding-ada-002:2` | 1536 | no | 2564 | Older model, superseded by text-embedding-3-*. NOT Matryoshka - excluded from the prefix index. |
| `voyage:voyage-3-large:1` | 1024 | yes | 3076 | Anthropic does not publish a first-party embedding model; Voyage AI is the embedding provider Anthropic points customers at, so 'Anthropic embeddings' in our code means this family. output_dimension is one of 2048, 1024 (default), 512, 256. |
| `voyage:voyage-3.5:1` | 1024 | yes | 3076 | Same Matryoshka ladder as voyage-3-large. |
| `voyage:voyage-3.5-lite:1` | 1024 | yes | 3076 | Cheaper tier for high-volume de-duplication passes. |
| `voyage:voyage-code-3:1` | 1024 | yes | 3076 | Code-specialized; used by the repo/diff correlation paths. |
| `google:gemini-embedding-001:1` | 3072 | yes | 1028 | Matryoshka: 3072 (default), 1536 and 768 are the documented output_dimensionality values. Google returns unnormalized vectors at reduced dimensionality, so the writer MUST L2-normalize before insert - the unit-norm CHECK will reject the row otherwise. |
| `google:text-embedding-004:1` | 768 | no | 3332 | Older Vertex text embedding model. |
| `google:text-multilingual-embedding-002:1` | 768 | no | 3332 | Multilingual sibling of text-embedding-004. |
| `qwen:Qwen3-Embedding-8B:1` | 4096 | yes | 4 | The model that sets the 4096 floor for this contract. MRL / variable output. Self-hosted, so normalization is our responsibility. |
| `qwen:Qwen3-Embedding-4B:1` | 2560 | yes | 1540 | Mid tier of the same family. |
| `qwen:Qwen3-Embedding-0.6B:1` | 1024 | yes | 3076 | Small tier; good default for high-volume near-duplicate detection. |
| `nvidia:NV-Embed-v2:1` | 4096 | no | 4 | Dedicated retrieval embedding model at 4096. NOT Matryoshka - truncating it is meaningless, so it is excluded from the prefix index and relies on the bit surface for candidate generation. |
| `baai:bge-en-icl:1` | 4096 | no | 4 | Mistral-based embedding model at 4096. In-context-learning retrieval model; not Matryoshka. |
| `baai:bge-m3:1` | 1024 | no | 3076 | Multilingual, multi-granularity; used where language coverage matters more than headroom. |
| `intfloat:e5-mistral-7b-instruct:1` | 4096 | no | 4 | Another 4096-wide Mistral-derived retrieval model; registered so the width is already covered. |

**"Anthropic embeddings" means Voyage.** Anthropic does not publish a
first-party embedding model; Voyage AI is the embedding provider Anthropic
directs customers to, so the `voyage` provider in the registry is what fills
that slot. Registering it under its real name rather than under `anthropic`
keeps the model key honest about what actually produced the vector.

## The part that is easy to get wrong

**pgvector cannot index a 4100-dimension vector column.** It can store up to
16000 dimensions, but HNSW and IVFFlat cap out at 2000 dimensions for the
`vector` type and 4000 for `halfvec`. A schema that declares `vector(4100)`
and then writes `CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)`
does not work - it fails at index creation.

So there is no index on the embedding column, and retrieval is two-stage:

1. **Candidates** come from a derived column that *is* indexable at 4100.
   - `embedding_bits` — `bit(4100)`, the sign bits of the embedding, HNSW with
     `bit_hamming_ops`. Bit indexes go to 64000 dimensions. Hamming over sign
     bits is a valid coarse proxy for cosine on any unit-norm vector, so this
     surface works for **every** model. The zero pad quantizes to a constant run
     of zero bits, which adds the same constant to every pairwise distance
     inside a model group and leaves the ranking alone.
   - `embedding_prefix` — `halfvec(1024)`, the leading 1024 components,
     HNSW with `halfvec_cosine_ops`, **partial on `mrl_prefix_valid`**. Higher
     recall than the bit surface, but only valid for Matryoshka-trained models,
     where the leading components genuinely carry most of the information. For a
     non-MRL model like NV-Embed-v2 or bge-en-icl a prefix is an arbitrary
     coordinate subset and means nothing, which is why the index is partial
     rather than global.
2. **Exact rerank** computes `embedding <=> $query` on the candidate rows only.

That second stage is also what keeps the TOAST cost bounded. 4100 float32s is
16408 bytes, past the ~8160-byte in-page tuple budget, so the embedding column is
always out of line; the column is set to `STORAGE EXTERNAL` because float32
does not compress and paying pglz on every write and every detoast buys nothing.
Stage 1 reads only index pages. Stage 2 detoasts a few hundred rows.

## Never compare across models

Two vectors from different models occupy different spaces, and padding them to
the same width does not change that. Every generated query filters on
`model_key` before any distance operator is evaluated, every ANN index is
scoped by `(account_id, model_key)`, and `cliptown_emb_one_row_per_entity_per_model`
lets one entity carry a row per model without the two ever being mixed.

## Hybrid, not vector-only

`search_document` is a stored `tsvector` built from three weighted sources -
`title_text` (A), `summary_text` (B), `body_text` (D) - with a GIN index. The
configuration is `simple` rather than a stemmer: these corpora are multilingual,
and a stemmer frozen into a STORED generated column cannot be changed later
without rewriting the table.

Lexical and vector results are combined by reciprocal rank fusion with k=60,
not by adding the scores. `ts_rank_cd` and cosine distance are not on a
comparable scale, and normalizing them against each other would invent a
calibration nobody measured. RRF only needs the ranks.

## CockroachDB

`db/schema/cockroach/` carries the distributed variant. CockroachDB has no
pgvector, so neither derived surface exists there; it has C-SPANN instead, which
accelerates **L2 distance only**. That is survivable precisely because this
contract mandates unit-norm vectors: for unit vectors `||a-b||² = 2 - 2·cos(a,b)`,
so L2 ordering and cosine ordering are the same ordering. The normalization rule
is what makes one set of rows serve both engines.

Two operator notes: vector indexes are behind
`SET CLUSTER SETTING feature.vector_index.enabled = true`, and creating one on a
non-empty table blocks writes during backfill. The `CREATE VECTOR INDEX`
statement is therefore left commented out in the schema file and applied
deliberately.

## Prerequisites

| component | minimum | why |
| --- | --- | --- |
| pgvector | >=0.7.0 | `halfvec`, `binary_quantize()`, `subvector()`, `l2_norm()` and the `bit_hamming_ops` / `halfvec_cosine_ops` operator classes all landed in 0.7.0. On 0.6.x this schema fails to create - the types simply are not there. |
| PostgreSQL | >=14 | STORED generated columns, `gen_random_uuid()`. |
| pgcrypto | migration only | `digest()` when backfilling `content_sha256`. |
| CockroachDB | >=25.2 | `VECTOR` and the C-SPANN index, plus `feature.vector_index.enabled`. |

```sql
select extversion from pg_extension where extname = 'vector';  -- expect >= 0.7.0
```

## Regenerating

```bash
node scripts/embeddings/generate.mjs          # write
node scripts/embeddings/generate.mjs --check  # CI gate; fails on drift
node --test tests/embeddings-contract.test.mjs
```

`db/embedding-contract.json` is vendored byte-identical into every org. Changing
it is a fleet change: regenerate in every org, or the checksum test fails.
