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

The repository emits PostgreSQL and SQLite DDL; SeaORM; Drizzle, Prisma, and
TypeORM; GORM and Ent; and Drift and Stormberry. Cross-language descriptors
implement the same stable entity-key routine from each entity's declared
primary key.

GORM is the writable Go adapter because it represents ordinary and composite
primary keys directly. Ent is the graph/schema-first Go adapter: ordinary
single-`id` entities are generated as `ent.Schema` types with `entsql.Skip()`,
while composite or non-`id` keys become read-only `ent.View` types so Ent cannot
invent a synthetic key. In both cases, generated SQL owns migrations,
foreign-key actions, CHECK constraints, and partial indexes.

Drift is the local Dart/Flutter adapter for reactive embedded stores.
Stormberry is the typed PostgreSQL Dart adapter. Its model annotations retain
canonical table names, SQL column names, defaults, indexes, and composite-key
members, but `stormberry migrate` is not a production migration path; generated
PostgreSQL SQL remains authoritative.

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
