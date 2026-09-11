# ClipTown embedding model-space v3

This additive contract keeps exactly 4,100 storage slots while distinguishing the 1–4,096 learned values from a required zero tail. Missing embeddings are `NULL`. Comparison identity includes provider, model revision, dimensions, normalization, task and instruction identity, input role, modality, metric, and preprocessing.

PostgreSQL and CockroachDB desired state remain product-owned in `cliptown/cliptown-lib-core`. TypeSpec and JSON Schema are peer contract authorities. The ORM accepts only typed, validated requests and never exposes raw SQL or migration execution. Application startup cannot apply DDL.

The exact baseline selects lexical and vector candidates independently, unions candidate identities, exact-scores the full vector, and uses reciprocal-rank fusion. No global filtered ANN graph is created. Every profile and comparison space is disabled until migration replay, tenant isolation, lexical-only behavior, exact-vs-ANN recall, rollback, and backup/restore evidence are reviewed.

Tracking: cliptown/cliptown-lib-core#9.
