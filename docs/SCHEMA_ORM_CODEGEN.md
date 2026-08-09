# JSON Schema and ORM generation

## Boundary

`schema/persistence.schema.json` is the portable persistence contract for
ClipTown encrypted metadata. It is pinned to an exact
`cliptown/cliptown-interfaces` revision in `schema/interfaces.lock.json` and
each persisted definition names the shared interface type it implements.

The existing Rust modules remain the transport-neutral domain-policy layer.
Generated persistence models are additive: they do not move database sessions,
HTTP concerns, storage clients, plaintext clipboard data, or key custody into
`cliptown-lib-core`.

## Generated targets

The repository emits PostgreSQL and SQLite DDL, SeaORM, Drizzle, Prisma,
TypeORM, GORM, and Drift definitions. Cross-language descriptors implement the
same stable entity-key routine from each entity's declared primary key.

GORM is the canonical Go adapter because the fleet contains real composite
keys. Drift is the Dart adapter because ClipTown clients need a type-safe,
code-generated embedded relational layer on desktop and mobile.

## Change protocol

1. Update the exact interfaces revision when consuming a reviewed interface
   change.
2. Change `schema/persistence.schema.json`, including `x-db` metadata.
3. Run `npm test && npm run generate`.
4. Review SQL first, then each ORM diff, then `generated/manifest.json`.
5. Merge only when codegen is deterministic and the encrypted-data boundary
   test remains green.

The generator accepts only safe snake-case SQL identifiers. Raw CHECK and
partial-index expressions are trusted review inputs and remain visible in both
the schema and generated SQL.
