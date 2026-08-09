import { spawnSync } from 'node:child_process';

import { GENERATED_HEADER, fail } from './core.mjs';

function formatGo(content) {
  const result = spawnSync('gofmt', [], { input: content, encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') fail('gofmt is required to generate canonical Ent output');
  if (result.status !== 0) fail(`gofmt failed: ${result.stderr || result.error || 'unknown error'}`);
  return result.stdout;
}

function entFieldBuilder(field) {
  const name = JSON.stringify(field.column);
  const property = field.property;
  let builder;
  if (field.kind === 'string') {
    if (property.enum?.length) builder = `field.Enum(${name}).Values(${property.enum.map((value) => JSON.stringify(value)).join(', ')})`;
    else if (property.format === 'uuid') builder = `field.UUID(${name}, uuid.UUID{})`;
    else if (property.format === 'date-time') builder = `field.Time(${name})`;
    else builder = `field.String(${name})`;
  } else if (field.kind === 'integer') {
    builder = property.format === 'int32' ? `field.Int32(${name})` : `field.Int64(${name})`;
  } else if (field.kind === 'number') builder = `field.Float(${name})`;
  else if (field.kind === 'boolean') builder = `field.Bool(${name})`;
  else if (field.kind === 'object' || field.kind === 'array') builder = `field.JSON(${name}, json.RawMessage{})`;
  else fail(`unsupported Ent type: ${field.kind}`);

  if (property.maxLength && field.kind === 'string' && !property.enum?.length) builder += `.MaxLen(${property.maxLength})`;
  if (field.nullable) builder += '.Optional().Nillable()';
  if (field.db.unique) builder += '.Unique()';
  builder += `.StructTag(${JSON.stringify(`json:\"${field.name},omitempty\"`)})`;

  const rawDefault = field.db.default ?? property.default;
  if (field.db.default === 'gen_random_uuid()') {
    builder += '.Default(uuid.New).Annotations(entsql.DefaultExpr("gen_random_uuid()"))';
  } else if (field.db.default && /^(now\(\)|current_timestamp)$/i.test(field.db.default)) {
    builder += `.Default(time.Now).Annotations(entsql.DefaultExpr(${JSON.stringify(field.db.default)}))`;
  } else if (property.default !== undefined) {
    if (field.kind === 'object' || field.kind === 'array') {
      builder += `.Default(json.RawMessage(${JSON.stringify(JSON.stringify(property.default))}))`;
    } else {
      builder += `.Default(${JSON.stringify(property.default)})`;
    }
  } else if (rawDefault !== undefined && rawDefault !== null) {
    builder += `.Annotations(entsql.DefaultExpr(${JSON.stringify(String(rawDefault))}))`;
  }
  if (field.db.references) {
    builder += `.Comment(${JSON.stringify(`Foreign key to ${field.db.references.entity}.${field.db.references.field}; DDL and referential actions are owned by generated SQL.`)})`;
  }
  return builder;
}

function generateEnt(model) {
  const usesJson = model.entities.some((entity) => entity.fields.some((field) => field.kind === 'object' || field.kind === 'array'));
  const usesTime = model.entities.some((entity) => entity.fields.some((field) => field.property.format === 'date-time'));
  const usesUuid = model.entities.some((entity) => entity.fields.some((field) => field.property.format === 'uuid'));
  const lines = [
    `// ${GENERATED_HEADER}`,
    '//',
    '// Generated SQL remains the migration and referential-integrity authority.',
    '// Ent schemas use entsql.Skip(); composite-key entities are emitted as read-only views',
    '// because Ent otherwise injects a synthetic single-column id.',
    'package schema',
    '',
    'import (',
  ];
  if (usesJson) lines.push('\t"encoding/json"');
  if (usesTime) lines.push('\t"time"');
  if (usesUuid) lines.push('', '\t"github.com/google/uuid"');
  lines.push('', '\t"entgo.io/ent"', '\t"entgo.io/ent/dialect/entsql"', '\tentschema "entgo.io/ent/schema"', '\t"entgo.io/ent/schema/field"', '\t"entgo.io/ent/schema/index"', ')', '');

  for (const entity of model.entities) {
    const writable = entity.primaryKey.length === 1 && entity.primaryKey[0] === 'id';
    lines.push(`// ${entity.className} maps ${entity.table}.`);
    if (!writable) lines.push('// It is read-only in Ent because the canonical table has a composite or non-id primary key.');
    lines.push(`type ${entity.className} struct {`, `\tent.${writable ? 'Schema' : 'View'}`, '}', '', `// Annotations configures the canonical table name without giving Ent migration ownership.`, `func (${entity.className}) Annotations() []entschema.Annotation {`, '\treturn []entschema.Annotation{', `\t\tentsql.Annotation{Table: ${JSON.stringify(entity.table)}},`);
    if (writable) lines.push('\t\tentsql.Skip(),');
    lines.push('\t}', '}', '', `// Fields returns fields derived from JSON Schema.`, `func (${entity.className}) Fields() []ent.Field {`, '\treturn []ent.Field{');
    for (const field of entity.fields) lines.push(`\t\t${entFieldBuilder(field)},`);
    lines.push('\t}', '}', '');
    if (writable && entity.indexes.length) {
      lines.push(`// Indexes returns reviewable indexes; generated SQL remains authoritative.`, `func (${entity.className}) Indexes() []ent.Index {`, '\treturn []ent.Index{');
      for (const spec of entity.indexes) {
        let value = `index.Fields(${spec.fields.map((name) => JSON.stringify(entity.fieldMap.get(name).column)).join(', ')})`;
        if (spec.unique) value += '.Unique()';
        if (spec.where) value += `.Annotations(entsql.IndexWhere(${JSON.stringify(spec.where)}))`;
        lines.push(`\t\t${value},`);
      }
      lines.push('\t}', '}', '');
    }
  }
  return formatGo(`${lines.join('\n').trimEnd()}\n`);
}

function stormberryType(field) {
  if (field.kind === 'string') return field.property.format === 'date-time' ? 'DateTime' : 'String';
  if (field.kind === 'integer') return 'int';
  if (field.kind === 'number') return 'double';
  if (field.kind === 'boolean') return 'bool';
  if (field.kind === 'object') return 'Map<String, dynamic>';
  if (field.kind === 'array') return 'List<dynamic>';
  fail(`unsupported Stormberry type: ${field.kind}`);
}

function stormberryDefault(field) {
  const raw = field.db.default ?? field.property.default;
  if (raw === undefined) return null;
  if (typeof raw === 'string' && /^(now\(\)|current_timestamp)$/i.test(raw)) return '@Default.currentTimestamp()';
  if (typeof raw === 'string' && raw === 'gen_random_uuid()') return `@Default('gen_random_uuid()')`;
  if (field.kind === 'string') return `@Default(${JSON.stringify(`'${String(raw).replaceAll("'", "''")}'`)})`;
  if (field.kind === 'object' || field.kind === 'array') return `@Default(${JSON.stringify(`'${JSON.stringify(raw).replaceAll("'", "''")}'::jsonb`)})`;
  return `@Default(${JSON.stringify(String(raw))})`;
}

function generateStormberry(model) {
  const lines = [
    `// ${GENERATED_HEADER}`,
    '//',
    '// This adapter provides typed PostgreSQL repositories. Do not run `stormberry migrate`',
    '// against production: generated/sql/postgres.sql remains the migration authority.',
    `import 'package:stormberry/stormberry.dart';`,
    '',
    `part 'models.schema.dart';`,
    '',
  ];
  for (const entity of model.entities) {
    if (entity.description) lines.push(`/// ${entity.description.replaceAll('\n', ' ')}`);
    const indexes = entity.indexes.map((spec) => {
      const args = [`name: ${JSON.stringify(spec.name)}`, `columns: [${spec.fields.map((name) => JSON.stringify(entity.fieldMap.get(name).column)).join(', ')}]`];
      if (spec.unique) args.push('unique: true');
      if (spec.where) args.push(`condition: ${JSON.stringify(spec.where)}`);
      return `TableIndex(${args.join(', ')})`;
    });
    if (indexes.length) {
      lines.push('@Model(', `  tableName: ${JSON.stringify(entity.table)},`, '  indexes: [');
      for (const spec of indexes) lines.push(`    ${spec},`);
      lines.push('  ],', ')');
    } else lines.push(`@Model(tableName: ${JSON.stringify(entity.table)})`);
    lines.push(`abstract class ${entity.className} {`);
    for (const field of entity.fields) {
      lines.push(`  /// JSON Schema property: ${field.name}; SQL column: ${field.column}.`);
      if (entity.primaryKey.includes(field.name)) lines.push('  @PrimaryKey()');
      const defaultAnnotation = stormberryDefault(field);
      if (defaultAnnotation) lines.push(`  ${defaultAnnotation}`);
      if (field.db.references) lines.push(`  /// Foreign key to ${field.db.references.entity}.${field.db.references.field}; constraints are SQL-managed.`);
      lines.push(`  ${stormberryType(field)}${field.nullable ? '?' : ''} get ${field.column};`, '');
    }
    lines.push('}', '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export { generateEnt, generateStormberry };
