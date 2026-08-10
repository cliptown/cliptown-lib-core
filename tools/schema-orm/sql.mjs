import { GENERATED_HEADER, fail, topologicalEntities } from './core.mjs';

function postgresType(field) {
  if (field.db.postgresType) return field.db.postgresType;
  const { property, kind } = field;
  if (kind === 'string') {
    if (property.format === 'uuid') return 'uuid';
    if (property.format === 'date-time') return 'timestamptz';
    if (property.maxLength && property.maxLength <= 10_000_000) return `varchar(${property.maxLength})`;
    return 'text';
  }
  if (kind === 'integer') return property.format === 'int32' ? 'integer' : 'bigint';
  if (kind === 'number') return 'double precision';
  if (kind === 'boolean') return 'boolean';
  if (kind === 'object' || kind === 'array') return 'jsonb';
  fail(`unsupported PostgreSQL type for ${field.name}: ${kind}`);
}

function sqliteType(field) {
  if (field.db.sqliteType) return field.db.sqliteType;
  if (field.kind === 'integer' || field.kind === 'boolean') return 'integer';
  if (field.kind === 'number') return 'real';
  return 'text';
}

function sqlLiteral(value) {
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (value === null) return 'null';
  return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
}

function sqlDefault(field, dialect) {
  if (field.db.defaultByDialect?.[dialect] !== undefined) return field.db.defaultByDialect[dialect];
  if (field.db.default !== undefined) {
    if (dialect === 'sqlite' && field.db.default === 'gen_random_uuid()') {
      return "(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))))";
    }
    return field.db.default;
  }
  if (field.property.default !== undefined) {
    if (dialect === 'sqlite' && (field.kind === 'object' || field.kind === 'array')) {
      return `'${JSON.stringify(field.property.default).replaceAll("'", "''")}'`;
    }
    return sqlLiteral(field.property.default);
  }
  return null;
}

function sqlColumn(field, dialect, entityMap) {
  const type = dialect === 'postgres' ? postgresType(field) : sqliteType(field);
  const pieces = [`  ${field.column} ${type}`];
  if (!field.nullable) pieces.push('not null');
  const defaultValue = sqlDefault(field, dialect);
  if (defaultValue !== null && defaultValue !== '') pieces.push(`default ${defaultValue}`);
  if (field.db.unique) pieces.push('unique');
  if (field.db.references) {
    const target = entityMap.get(field.db.references.entity);
    const targetField = target.fieldMap.get(field.db.references.field);
    pieces.push(`references ${target.table} (${targetField.column})`);
    if (field.db.references.onUpdate) pieces.push(`on update ${field.db.references.onUpdate}`);
    if (field.db.references.onDelete) pieces.push(`on delete ${field.db.references.onDelete}`);
  }
  return pieces.join(' ');
}

function generateSql(model, dialect) {
  const lines = [`-- ${GENERATED_HEADER}`, `-- Product: ${model.root.product}`, `-- Dialect: ${dialect}`, ''];
  for (const entity of topologicalEntities(model)) {
    if (entity.description) lines.push(`-- ${entity.description.replace(/[\r\n\u2028\u2029]+/gu, ' ')}`);
    lines.push(`create table if not exists ${entity.table} (`);
    const clauses = entity.fields.map((field) => sqlColumn(field, dialect, model.entityMap));
    clauses.push(`  primary key (${entity.primaryKey.map((key) => entity.fieldMap.get(key).column).join(', ')})`);
    for (const field of entity.fields) {
      if (field.property.enum?.length) {
        const allowed = field.property.enum.map((value) => sqlLiteral(value)).join(', ');
        clauses.push(`  constraint ${entity.table}_${field.column}_chk check (${field.column} in (${allowed}))`);
      }
    }
    for (const check of entity.checks) clauses.push(`  constraint ${check.name} check (${check.expression})`);
    lines.push(clauses.join(',\n'));
    lines.push(');', '');
    for (const index of entity.indexes) {
      const unique = index.unique ? 'unique ' : '';
      const fields = index.fields.map((field) => entity.fieldMap.get(field).column).join(', ');
      const where = index.where ? ` where ${index.where}` : '';
      lines.push(`create ${unique}index if not exists ${index.name} on ${entity.table} (${fields})${where};`);
    }
    if (entity.indexes.length) lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}


export { generateSql, postgresType, sqlDefault };
