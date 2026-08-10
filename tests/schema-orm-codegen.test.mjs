import assert from 'node:assert/strict';
import test from 'node:test';

import { assertOutputRoot, generateFiles, generatorSha256, normalizeSchema } from '../tools/schema-orm-codegen.mjs';

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
  assert.equal(first.manifest.generatorVersion, 3);
  assert.equal(first.manifest.generatorSha256, generatorSha256());
  assert.match(first.manifest.generatorSha256, /^[0-9a-f]{64}$/);
  assert.ok(first.manifest.generatorFiles.includes('tools/schema-orm/sql.mjs'));
  for (const path of [
    'sql/postgres.sql',
    'sql/sqlite.sql',
    'rust/sea-orm/entities.rs',
    'node/drizzle/schema.ts',
    'node/prisma/schema.prisma',
    'node/typeorm/entities.ts',
    'go/gorm/models.go',
    'go/ent/schema/entities.go',
    'dart/drift/tables.dart',
    'dart/stormberry/models.dart',
  ]) assert.ok(first.files.has(path), path);
  assert.match(first.files.get('go/gorm/models.go'), /primaryKey;autoIncrement:false/);
  assert.match(first.files.get('node/drizzle/schema.ts'), /primaryKey\(\{ columns:/);
  assert.match(first.files.get('rust/sea-orm/entities.rs'), /primary_key, auto_increment = false/);
  assert.match(first.files.get('node/prisma/schema.prisma'), /@@id\(\[parentId, subjectId\]\)/);
  assert.doesNotMatch(first.files.get('node/prisma/schema.prisma'), /@@index\(\[subjectId, parentId\]/);
  assert.match(first.files.get('node/prisma/schema.prisma'), /Partial index test_memberships_subject_idx/);
  assert.match(first.files.get('go/gorm/models.go'), /index:test_memberships_subject_idx,priority:1,where:role = 'member'/);
  assert.match(first.files.get('dart/drift/tables.dart'), /@TableIndex\.sql/);

  const ent = first.files.get('go/ent/schema/entities.go');
  assert.match(ent, /type Parent struct \{\s+ent\.Schema/);
  assert.match(ent, /entsql\.Skip\(\)/);
  assert.match(ent, /type Membership struct \{\s+ent\.View/);
  assert.doesNotMatch(ent, /func \(Membership\) Indexes/);

  const stormberry = first.files.get('dart/stormberry/models.dart');
  assert.match(stormberry, /@Model\(\s+tableName: "test_memberships"/);
  assert.match(stormberry, /condition: "role = 'member'"/);
  assert.equal((stormberry.match(/@PrimaryKey\(\)/g) ?? []).length, 3);
});

test('rejects unsafe SQL identifiers', () => {
  const bad = structuredClone(schema);
  bad.$defs.Parent['x-db'].table = 'test_parents; drop table users';
  assert.throws(() => normalizeSchema(bad), /safe snake_case identifier/);
});

test('refuses destructive generation outside the repository generated tree', () => {
  assert.throws(() => assertOutputRoot('/tmp/not-cliptown-generated'), /refusing to delete or generate outside/);
});

test('rejects SQL fragment escape in defaults, checks, predicates, and custom types', () => {
  const badDefault = structuredClone(schema);
  badDefault.$defs.Parent.properties.id['x-db'].default = 'gen_random_uuid()); drop table users; --';
  assert.throws(() => normalizeSchema(badDefault), /statement terminator or SQL comment/);

  const badCheck = structuredClone(schema);
  badCheck.$defs.Parent['x-db'].checks = [{
    name: 'test_parents_escape_chk',
    expression: 'true), injected text, constraint x check (true',
  }];
  assert.throws(() => normalizeSchema(badCheck), /closes a parenthesis outside its expression/);

  const badPredicate = structuredClone(schema);
  badPredicate.$defs.Membership['x-db'].indexes[0].where = "role = 'member'; drop table users";
  assert.throws(() => normalizeSchema(badPredicate), /statement terminator or SQL comment/);

  const badType = structuredClone(schema);
  badType.$defs.Parent.properties.name['x-db'] = { postgresType: 'text not null' };
  assert.throws(() => normalizeSchema(badType), /safe SQL type fragment/);
});

test('rejects duplicate generated database names and malformed schema metadata', () => {
  const duplicateColumn = structuredClone(schema);
  duplicateColumn.$defs.Parent.properties.name['x-db'] = { column: 'id' };
  assert.throws(() => normalizeSchema(duplicateColumn), /duplicate persistence column names/);

  const duplicatePrimaryKey = structuredClone(schema);
  duplicatePrimaryKey.$defs.Parent['x-db'].primaryKey = ['id', 'id'];
  assert.throws(() => normalizeSchema(duplicatePrimaryKey), /primary key contains duplicate fields/);

  const unknownRequired = structuredClone(schema);
  unknownRequired.$defs.Parent.required.push('missingField');
  assert.throws(() => normalizeSchema(unknownRequired), /required references unknown field/);

  const invalidLength = structuredClone(schema);
  invalidLength.$defs.Parent.properties.name.maxLength = -1;
  assert.throws(() => normalizeSchema(invalidLength), /positive safe integer/);
});
