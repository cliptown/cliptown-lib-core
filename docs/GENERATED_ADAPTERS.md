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
| `go/gorm/models.go` | GORM models, including composite keys and index tags |
| `dart/drift/tables.dart` | Drift table definitions for Dart and Flutter |
| `shared/*` | Cross-language entity descriptors and stable entity-key routines |
| `manifest.json` | Schema fingerprint and output fingerprints |

Do not hand-edit generated files. Change the JSON Schema, run `npm run generate`,
and review the resulting semantic diff. Database-specific policies that cannot be
represented without loss remain hand-authored and are explicitly documented.
