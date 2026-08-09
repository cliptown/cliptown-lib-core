import assert from 'node:assert/strict';
import test from 'node:test';

import { generateFiles, normalizeSchema } from '../tools/schema-orm-codegen.mjs';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://example.test/schema.json',
  type: 'object',
  'x-lib-core': {
    product: 'test-product',
    interfaces: { repository: 'example/test-interfaces', revision: '0123456789abcdef' },
  },
  $defs: {
    Parent: {
      type: 'object',
      required: ['id', 'name'],
      'x-db': { table: 'test_parents', primaryKey: ['id'] },
      properties: {
        id: { type: 'string', format: 'uuid', 'x-db': { default: 'gen_random_uuid()' } },
        name: { type: 'string', maxLength: 100 },
      },
    },
    Membership: {
      type: 'object',
      required: ['parentId', 'subjectId', 'role', 'createdAt'],
      'x-db': {
        table: 'test_memberships',
        primaryKey: ['parentId', 'subjectId'],
        indexes: [{ fields: ['subjectId', 'parentId'], name: 'test_memberships_subject_idx', where: "role = 'member'" }],
      },
      properties: {
        parentId: { type: 'string', format: 'uuid', 'x-db': { references: { entity: 'Parent', field: 'id', onDelete: 'cascade' } } },
        subjectId: { type: 'string', format: 'uuid' },
        role: { type: 'string', enum: ['owner', 'member'] },
        createdAt: { type: 'string', format: 'date-time', 'x-db': { default: 'now()', defaultByDialect: { sqlite: 'current_timestamp' } } },
      },
    },
  },
};

test('normalizes entities and composite keys', () => {
  const model = normalizeSchema(schema);
  assert.equal(model.entities.length, 2);
  assert.deepEqual(model.entityMap.get('Membership').primaryKey, ['parentId', 'subjectId']);
});

test('generation is deterministic and covers every requested ORM', () => {
  const first = generateFiles(schema);
  const second = generateFiles(JSON.parse(JSON.stringify(schema)));
  assert.deepEqual([...first.files], [...second.files]);
  for (const path of [
    'sql/postgres.sql',
    'sql/sqlite.sql',
    'rust/sea-orm/entities.rs',
    'node/drizzle/schema.ts',
    'node/prisma/schema.prisma',
    'node/typeorm/entities.ts',
    'go/gorm/models.go',
    'dart/drift/tables.dart',
  ]) assert.ok(first.files.has(path), path);
  assert.match(first.files.get('go/gorm/models.go'), /primaryKey;autoIncrement:false/);
  assert.match(first.files.get('node/drizzle/schema.ts'), /primaryKey\(\{ columns:/);
  assert.match(first.files.get('rust/sea-orm/entities.rs'), /primary_key, auto_increment = false/);
  assert.match(first.files.get('node/prisma/schema.prisma'), /@@id\(\[parentId, subjectId\]\)/);
  assert.doesNotMatch(first.files.get('node/prisma/schema.prisma'), /@@index\(\[subjectId, parentId\]/);
  assert.match(first.files.get('node/prisma/schema.prisma'), /Partial index test_memberships_subject_idx/);
  assert.match(first.files.get('go/gorm/models.go'), /index:test_memberships_subject_idx,priority:1,where:role = 'member'/);
  assert.match(first.files.get('dart/drift/tables.dart'), /@TableIndex\.sql/);
});

test('rejects unsafe SQL identifiers', () => {
  const bad = structuredClone(schema);
  bad.$defs.Parent['x-db'].table = 'test_parents; drop table users';
  assert.throws(() => normalizeSchema(bad), /safe snake_case identifier/);
});
