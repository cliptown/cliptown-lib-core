# Schema ORM generator hardening

Tracking: `DEN-3321`

The JSON Schema persistence generator is intentionally constrained to the repository's committed `generated/` tree. It must not be used as a general-purpose filesystem writer or migration executor.

## Safety boundary

The generator now:

- resolves its repository root from the checked-in entrypoint rather than the caller's working directory;
- refuses output paths outside the exact repository `generated/` directory;
- records the complete ordered generator-file set and a SHA-256 provenance digest in `generated/manifest.json`;
- treats generator-source drift and stale generated files as review-required failures;
- validates custom PostgreSQL and SQLite type fragments before rendering them;
- rejects SQL defaults, index predicates, and check expressions containing statement terminators, comments, clause escapes, unbalanced delimiters, or statement-level keywords;
- rejects duplicate columns, primary-key fields, indexes, checks, and product-wide index names;
- validates required-field references, positive `maxLength` values, supported dialect keys, and a safe product slug.

`generated/sql/postgres.sql` remains the only migration authority. Generated ORM adapters do not gain authority to apply migrations, open connections, authorize callers, or handle plaintext clipboard values or encryption keys.

## Validation

The recovery was applied to the existing feature branch without a force push. Before the final commit, the exact patch passed:

```text
node --check tools/schema-orm-codegen.mjs
node --check tools/schema-orm/core.mjs
node --check tools/schema-orm/sql.mjs
node --test tests/schema-orm-codegen.test.mjs
node tools/schema-orm-codegen.mjs
node tools/schema-orm-codegen.mjs --check
bash tests/check-generated-go.sh
```

The adversarial tests cover SQL statement injection, unsafe type fragments, duplicate persistence metadata, unsupported dialects, destructive output-root escape attempts, stale generator provenance, and deterministic regeneration.
