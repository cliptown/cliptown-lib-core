import {
  GENERATED_HEADER,
  camelCase,
  fail,
  pascalCase,
  pluralize,
  topologicalEntities,
  tsName,
} from './core.mjs';
import { sqlDefault } from './sql.mjs';

function drizzleBuilder(field) {
  const column = JSON.stringify(field.column);
  let value;
  if (field.kind === 'string') {
    if (field.property.format === 'uuid') value = `uuid(${column})`;
    else if (field.property.format === 'date-time') value = `timestamp(${column}, { withTimezone: true, mode: 'date' })`;
    else if (field.property.maxLength) value = `varchar(${column}, { length: ${field.property.maxLength} })`;
    else value = `text(${column})`;
  } else if (field.kind === 'integer') {
    value = field.property.format === 'int32' ? `integer(${column})` : `bigint(${column}, { mode: 'bigint' })`;
  } else if (field.kind === 'number') value = `doublePrecision(${column})`;
  else if (field.kind === 'boolean') value = `boolean(${column})`;
  else if (field.kind === 'object' || field.kind === 'array') value = `jsonb(${column})`;
  else fail(`unsupported Drizzle type: ${field.kind}`);
  const defaultValue = sqlDefault(field, 'postgres');
  if (defaultValue === 'gen_random_uuid()') value += '.defaultRandom()';
  else if (defaultValue && /^(now\(\)|current_timestamp)$/i.test(defaultValue)) value += '.defaultNow()';
  else if (field.property.default !== undefined) value += `.default(${JSON.stringify(field.property.default)})`;
  if (!field.nullable) value += '.notNull()';
  if (field.db.unique) value += '.unique()';
  return value;
}

function generateDrizzle(model) {
  const imports = ['pgTable', 'uuid', 'text', 'varchar', 'integer', 'bigint', 'boolean', 'timestamp', 'jsonb', 'doublePrecision', 'primaryKey', 'uniqueIndex', 'index', 'check'];
  const lines = [
    `// ${GENERATED_HEADER}`,
    `import { ${imports.join(', ')} } from 'drizzle-orm/pg-core';`,
    `import { sql } from 'drizzle-orm';`,
    '',
  ];
  const variable = new Map(model.entities.map((entity) => [entity.name, camelCase(entity.name)]));
  for (const entity of topologicalEntities(model)) {
    lines.push(`export const ${variable.get(entity.name)} = pgTable(${JSON.stringify(entity.table)}, {`);
    for (const field of entity.fields) {
      let builder = drizzleBuilder(field);
      if (entity.primaryKey.length === 1 && entity.primaryKey[0] === field.name) builder += '.primaryKey()';
      if (field.db.references) {
        const target = model.entityMap.get(field.db.references.entity);
        const targetField = target.fieldMap.get(field.db.references.field);
        const options = [];
        if (field.db.references.onDelete) options.push(`onDelete: ${JSON.stringify(field.db.references.onDelete.toLowerCase())}`);
        if (field.db.references.onUpdate) options.push(`onUpdate: ${JSON.stringify(field.db.references.onUpdate.toLowerCase())}`);
        builder += `.references(() => ${variable.get(target.name)}.${tsName(targetField.name)}${options.length ? `, { ${options.join(', ')} }` : ''})`;
      }
      lines.push(`  ${tsName(field.name)}: ${builder},`);
    }
    const extras = [];
    if (entity.primaryKey.length > 1) extras.push(`primaryKey({ columns: [${entity.primaryKey.map((field) => `table.${tsName(field)}`).join(', ')}] })`);
    for (const indexSpec of entity.indexes) {
      const factory = indexSpec.unique ? 'uniqueIndex' : 'index';
      let expression = `${factory}(${JSON.stringify(indexSpec.name)}).on(${indexSpec.fields.map((field) => `table.${tsName(field)}`).join(', ')})`;
      if (indexSpec.where) expression += `.where(sql.raw(${JSON.stringify(indexSpec.where)}))`;
      extras.push(expression);
    }
    for (const checkSpec of entity.checks) extras.push(`check(${JSON.stringify(checkSpec.name)}, sql.raw(${JSON.stringify(checkSpec.expression)}))`);
    for (const field of entity.fields) {
      if (field.property.enum?.length) {
        const allowed = field.property.enum.map((value) => `'${String(value).replaceAll("'", "''")}'`).join(', ');
        extras.push(`check(${JSON.stringify(`${entity.table}_${field.column}_chk`)}, sql.raw(${JSON.stringify(`${field.column} in (${allowed})`)}))`);
      }
    }
    lines.push(`}, (table) => [${extras.length ? `\n  ${extras.join(',\n  ')}\n` : ''}]);`, '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function prismaType(field) {
  if (field.kind === 'string') {
    if (field.property.format === 'date-time') return ['DateTime', '@db.Timestamptz(6)'];
    if (field.property.format === 'uuid') return ['String', '@db.Uuid'];
    if (field.property.maxLength) return ['String', `@db.VarChar(${field.property.maxLength})`];
    return ['String', '@db.Text'];
  }
  if (field.kind === 'integer') return [field.property.format === 'int32' ? 'Int' : 'BigInt', ''];
  if (field.kind === 'number') return ['Float', ''];
  if (field.kind === 'boolean') return ['Boolean', ''];
  if (field.kind === 'object' || field.kind === 'array') return ['Json', ''];
  fail(`unsupported Prisma type: ${field.kind}`);
}

function prismaDefault(field) {
  const value = sqlDefault(field, 'postgres');
  if (!value) return '';
  if (value === 'gen_random_uuid()') return '@default(uuid())';
  if (/^(now\(\)|current_timestamp)$/i.test(value)) return '@default(now())';
  if (field.property.default !== undefined) {
    const raw = field.property.default;
    if (typeof raw === 'string') return `@default(${JSON.stringify(raw)})`;
    if (typeof raw === 'boolean' || typeof raw === 'number') return `@default(${raw})`;
    if (Array.isArray(raw) && raw.length === 0) return '@default("[]")';
    if (raw && typeof raw === 'object' && Object.keys(raw).length === 0) return '@default("{}")';
  }
  return `@default(dbgenerated(${JSON.stringify(value)}))`;
}

function relationName(source, field, target) {
  return `${source.className}_${pascalCase(field.name)}_${target.className}`;
}

function generatePrisma(model) {
  const incoming = new Map(model.entities.map((entity) => [entity.name, []]));
  for (const source of model.entities) {
    for (const field of source.fields.filter((field) => field.db.references)) {
      incoming.get(field.db.references.entity).push({ source, field });
    }
  }
  const lines = [
    `// ${GENERATED_HEADER}`,
    'generator client {',
    '  provider = "prisma-client-js"',
    '}',
    '',
    'datasource db {',
    '  provider = "postgresql"',
    '  url      = env("DATABASE_URL")',
    '}',
    '',
  ];
  for (const entity of model.entities) {
    lines.push(`model ${entity.className} {`);
    for (const field of entity.fields) {
      const [type, native] = prismaType(field);
      const optional = field.nullable ? '?' : '';
      const attrs = [];
      if (entity.primaryKey.length === 1 && entity.primaryKey[0] === field.name) attrs.push('@id');
      if (field.db.unique) attrs.push('@unique');
      const defaultValue = prismaDefault(field);
      if (defaultValue) attrs.push(defaultValue);
      if (native) attrs.push(native);
      if (field.column !== field.name) attrs.push(`@map(${JSON.stringify(field.column)})`);
      lines.push(`  ${tsName(field.name)} ${type}${optional}${attrs.length ? ` ${attrs.join(' ')}` : ''}`);
    }
    for (const field of entity.fields.filter((field) => field.db.references)) {
      const target = model.entityMap.get(field.db.references.entity);
      const rel = relationName(entity, field, target);
      const relationField = `${camelCase(target.name)}By${pascalCase(field.name)}`;
      const optional = field.nullable ? '?' : '';
      const deleteAction = field.db.references.onDelete ? `, onDelete: ${pascalCase(field.db.references.onDelete)}` : '';
      const updateAction = field.db.references.onUpdate ? `, onUpdate: ${pascalCase(field.db.references.onUpdate)}` : '';
      lines.push(`  ${relationField} ${target.className}${optional} @relation(${JSON.stringify(rel)}, fields: [${tsName(field.name)}], references: [${tsName(field.db.references.field)}]${deleteAction}${updateAction})`);
    }
    for (const rel of incoming.get(entity.name)) {
      const relName = relationName(rel.source, rel.field, entity);
      const backName = `${camelCase(pluralize(rel.source.name))}By${pascalCase(rel.field.name)}`;
      lines.push(`  ${backName} ${rel.source.className}[] @relation(${JSON.stringify(relName)})`);
    }
    if (entity.primaryKey.length > 1) lines.push(`  @@id([${entity.primaryKey.map(tsName).join(', ')}])`);
    for (const indexSpec of entity.indexes) {
      if (indexSpec.where) {
        lines.push(`  /// Partial index ${indexSpec.name}: ${indexSpec.fields.join(', ')} WHERE ${indexSpec.where}. Managed by generated SQL.`);
        continue;
      }
      const directive = indexSpec.unique ? '@@unique' : '@@index';
      lines.push(`  ${directive}([${indexSpec.fields.map(tsName).join(', ')}], map: ${JSON.stringify(indexSpec.name)})`);
    }
    for (const checkSpec of entity.checks) lines.push(`  /// SQL CHECK ${checkSpec.name}: ${checkSpec.expression}`);
    lines.push(`  @@map(${JSON.stringify(entity.table)})`, '}', '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function typeormType(field) {
  if (field.kind === 'string') {
    if (field.property.format === 'uuid') return ['uuid', 'string'];
    if (field.property.format === 'date-time') return ['timestamptz', 'Date'];
    if (field.property.maxLength) return ['varchar', 'string'];
    return ['text', 'string'];
  }
  if (field.kind === 'integer') return [field.property.format === 'int32' ? 'integer' : 'bigint', field.property.format === 'int32' ? 'number' : 'string'];
  if (field.kind === 'number') return ['double precision', 'number'];
  if (field.kind === 'boolean') return ['boolean', 'boolean'];
  if (field.kind === 'object') return ['jsonb', 'Record<string, unknown>'];
  if (field.kind === 'array') return ['jsonb', 'unknown[]'];
  fail(`unsupported TypeORM type: ${field.kind}`);
}

function generateTypeOrm(model) {
  const lines = [
    `// ${GENERATED_HEADER}`,
    `import { Check, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';`,
    '',
  ];
  for (const entity of model.entities) {
    for (const indexSpec of entity.indexes) lines.push(`@Index(${JSON.stringify(indexSpec.name)}, [${indexSpec.fields.map((field) => JSON.stringify(tsName(field))).join(', ')}], { unique: ${Boolean(indexSpec.unique)}${indexSpec.where ? `, where: ${JSON.stringify(indexSpec.where)}` : ''} })`);
    for (const checkSpec of entity.checks) lines.push(`@Check(${JSON.stringify(checkSpec.name)}, ${JSON.stringify(checkSpec.expression)})`);
    for (const field of entity.fields.filter((field) => field.property.enum?.length)) {
      const allowed = field.property.enum.map((value) => `'${String(value).replaceAll("'", "''")}'`).join(', ');
      lines.push(`@Check(${JSON.stringify(`${entity.table}_${field.column}_chk`)}, ${JSON.stringify(`${field.column} in (${allowed})`)})`);
    }
    lines.push(`@Entity(${JSON.stringify(entity.table)})`, `export class ${entity.className} {`);
    for (const field of entity.fields) {
      const [dbType, tsType] = typeormType(field);
      const options = [`name: ${JSON.stringify(field.column)}`, `type: ${JSON.stringify(dbType)}`];
      if (field.property.maxLength && dbType === 'varchar') options.push(`length: ${field.property.maxLength}`);
      if (field.nullable) options.push('nullable: true');
      const defaultValue = sqlDefault(field, 'postgres');
      if (defaultValue) options.push(`default: () => ${JSON.stringify(defaultValue)}`);
      if (field.db.unique) options.push('unique: true');
      const decorator = entity.primaryKey.includes(field.name) ? 'PrimaryColumn' : 'Column';
      lines.push(`  @${decorator}({ ${options.join(', ')} })`, `  ${tsName(field.name)}${field.nullable ? '?' : '!'}: ${tsType};`, '');
      if (field.db.references) {
        const target = model.entityMap.get(field.db.references.entity);
        const relationOptions = [`nullable: ${field.nullable}`];
        if (field.db.references.onDelete) relationOptions.push(`onDelete: ${JSON.stringify(field.db.references.onDelete.toUpperCase())}`);
        if (field.db.references.onUpdate) relationOptions.push(`onUpdate: ${JSON.stringify(field.db.references.onUpdate.toUpperCase())}`);
        lines.push(`  @ManyToOne(() => ${target.className}, { ${relationOptions.join(', ')} })`, `  @JoinColumn({ name: ${JSON.stringify(field.column)}, referencedColumnName: ${JSON.stringify(tsName(field.db.references.field))} })`, `  ${camelCase(target.name)}By${pascalCase(field.name)}${field.nullable ? '?' : '!'}: ${target.className};`, '');
      }
    }
    lines.push('}', '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}


export { generateDrizzle, generatePrisma, generateTypeOrm };
