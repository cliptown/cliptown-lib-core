# Generated persistence adapters

Everything below this directory is generated from
`schema/persistence.schema.json` by `tools/schema-orm-codegen.mjs`.

| Output | Role |
| --- | --- |
| `sql/postgres.sql` | Portable PostgreSQL table, key, check, and index DDL |
| `sql/sqlite.sql` | SQLite/embedded equivalent for local and mobile stores |
| `rust/sea-orm/entities.rs` | SeaORM entity definitions |
| `node/drizzle/schema.ts` | Drizzle PostgreSQL schema |
| `node/prisma/schema.prisma` | Prisma models; partial indexes and CHECK constraints remain SQL-managed |
| `node/typeorm/entities.ts` | TypeORM entities, relations, indexes, and checks |
| `go/gorm/models.go` | GORM models, including composite keys, relations, and index tags |
| `go/ent/schema/entities.go` | Ent schemas with migration ownership disabled; composite-key tables are read-only Ent views |
| `dart/drift/tables.dart` | Drift table definitions for local, desktop, and mobile relational stores |
| `dart/stormberry/models.dart` | Stormberry PostgreSQL models and repositories; production migration remains SQL-managed |
| `shared/*` | Cross-language entity descriptors and stable entity-key routines |
| `manifest.json` | Schema fingerprint and output fingerprints |

Do not hand-edit generated files. Change the JSON Schema, run `npm run generate`,
and review the resulting semantic diff. Database-specific policies that cannot be
represented without loss remain hand-authored and are explicitly documented.

The generated SQL is the only migration authority. ORM migration commands are
not interchangeable with that SQL: they may omit CHECK constraints, partial
indexes, composite-key semantics, row-level security, grants, triggers, or other
provider-specific policies.
