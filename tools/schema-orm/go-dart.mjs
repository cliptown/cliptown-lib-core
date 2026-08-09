import { spawnSync } from 'node:child_process';

import { GENERATED_HEADER, camelCase, dartName, fail, goName } from './core.mjs';
import { postgresType, sqlDefault } from './sql.mjs';

function goScalar(field) {
  if (field.kind === 'string') {
    if (field.property.format === 'uuid') return 'uuid.UUID';
    if (field.property.format === 'date-time') return 'time.Time';
    return 'string';
  }
  if (field.kind === 'integer') return field.property.format === 'int32' ? 'int32' : 'int64';
  if (field.kind === 'number') return 'float64';
  if (field.kind === 'boolean') return 'bool';
  if (field.kind === 'object' || field.kind === 'array') return 'json.RawMessage';
  fail(`unsupported Go type: ${field.kind}`);
}

function formatGo(content) {
  const result = spawnSync('gofmt', [], { input: content, encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') fail('gofmt is required to generate canonical Go ORM output');
  if (result.status !== 0) fail(`gofmt failed: ${result.stderr || result.error || 'unknown error'}`);
  return result.stdout;
}

function generateGorm(model) {
  const usesJson = model.entities.some((entity) => entity.fields.some((field) => field.kind === 'object' || field.kind === 'array'));
  const usesTime = model.entities.some((entity) => entity.fields.some((field) => field.property.format === 'date-time'));
  const usesUuid = model.entities.some((entity) => entity.fields.some((field) => field.property.format === 'uuid'));
  const lines = [
    `// ${GENERATED_HEADER}`,
    'package models',
    '',
  ];
  const imports = [];
  if (usesJson) imports.push('"encoding/json"');
  if (usesTime) imports.push('"time"');
  if (usesUuid) imports.push('"github.com/google/uuid"');
  if (imports.length) {
    lines.push('import (');
    for (const item of imports) lines.push(`  ${item}`);
    lines.push(')', '');
  }
  for (const entity of model.entities) {
    lines.push(`type ${entity.className} struct {`);
    for (const field of entity.fields) {
      let type = goScalar(field);
      if (field.nullable) type = `*${type}`;
      const tags = [`column:${field.column}`, `type:${postgresType(field)}`];
      if (entity.primaryKey.includes(field.name)) tags.push('primaryKey', 'autoIncrement:false');
      if (!field.nullable) tags.push('not null');
      if (field.db.unique) tags.push('unique');
      const defaultValue = sqlDefault(field, 'postgres');
      if (defaultValue) tags.push(`default:${defaultValue}`);
      for (const indexSpec of entity.indexes.filter((candidate) => candidate.fields.includes(field.name))) {
        const priority = indexSpec.fields.indexOf(field.name) + 1;
        const options = [`priority:${priority}`];
        if (indexSpec.unique) options.push('unique');
        if (indexSpec.where) options.push(`where:${indexSpec.where}`);
        tags.push(`index:${indexSpec.name},${options.join(',')}`);
      }
      lines.push(`  ${goName(field.name)} ${type} \`json:"${field.name}" gorm:"${tags.join(';')}"\``);
    }
    for (const field of entity.fields.filter((field) => field.db.references)) {
      const target = model.entityMap.get(field.db.references.entity);
      const relationTags = [`foreignKey:${goName(field.name)}`, `references:${goName(field.db.references.field)}`];
      const constraints = [];
      if (field.db.references.onUpdate) constraints.push(`OnUpdate:${field.db.references.onUpdate.toUpperCase()}`);
      if (field.db.references.onDelete) constraints.push(`OnDelete:${field.db.references.onDelete.toUpperCase()}`);
      if (constraints.length) relationTags.push(`constraint:${constraints.join(',')}`);
      lines.push(`  ${target.className}By${goName(field.name)} ${field.nullable ? '*' : ''}${target.className} \`json:"-" gorm:"${relationTags.join(';')}"\``);
    }
    lines.push('}', '', `func (${entity.className}) TableName() string { return ${JSON.stringify(entity.table)} }`, '');
  }
  return formatGo(`${lines.join('\n').trimEnd()}\n`);
}

function dartScalar(field) {
  if (field.kind === 'string') {
    if (field.property.format === 'date-time') return 'dateTime';
    return 'text';
  }
  if (field.kind === 'integer') return field.property.format === 'int64' ? 'int64' : 'integer';
  if (field.kind === 'number') return 'real';
  if (field.kind === 'boolean') return 'boolean';
  if (field.kind === 'object' || field.kind === 'array') return 'text';
  fail(`unsupported Drift type: ${field.kind}`);
}

function generateDrift(model) {
  const lines = [
    `// ${GENERATED_HEADER}`,
    `import 'package:drift/drift.dart';`,
    '',
  ];
  const columnClass = (field) => {
    const builder = dartScalar(field);
    return ({ text: 'TextColumn', dateTime: 'DateTimeColumn', integer: 'IntColumn', int64: 'BigIntColumn', real: 'RealColumn', boolean: 'BoolColumn' })[builder];
  };
  for (const entity of model.entities) {
    for (const indexSpec of entity.indexes) {
      if (indexSpec.where) {
        const unique = indexSpec.unique ? 'UNIQUE ' : '';
        const columns = indexSpec.fields.map((field) => entity.fieldMap.get(field).column).join(', ');
        lines.push(`@TableIndex.sql(${JSON.stringify(`CREATE ${unique}INDEX ${indexSpec.name} ON ${entity.table} (${columns}) WHERE ${indexSpec.where}`)})`);
      } else {
        lines.push(`@TableIndex(name: ${JSON.stringify(indexSpec.name)}, columns: {${indexSpec.fields.map((field) => `#${dartName(field)}`).join(', ')}}, unique: ${Boolean(indexSpec.unique)})`);
      }
    }
    lines.push(`class ${entity.className} extends Table {`, `  @override`, `  String get tableName => ${JSON.stringify(entity.table)};`, '');
    for (const field of entity.fields) {
      let builder = `${dartScalar(field)}().named(${JSON.stringify(field.column)})`;
      if (field.db.references) {
        const target = model.entityMap.get(field.db.references.entity);
        const options = [];
        if (field.db.references.onDelete) options.push(`onDelete: KeyAction.${camelCase(field.db.references.onDelete.replace(' ', '_'))}`);
        if (field.db.references.onUpdate) options.push(`onUpdate: KeyAction.${camelCase(field.db.references.onUpdate.replace(' ', '_'))}`);
        builder += `.references(${target.className}, #${dartName(field.db.references.field)}${options.length ? `, ${options.join(', ')}` : ''})`;
      }
      if (field.property.maxLength && field.kind === 'string') builder += `.withLength(max: ${field.property.maxLength})`;
      if (field.db.unique) builder += '.unique()';
      if (field.nullable) builder += '.nullable()';
      const defaultValue = sqlDefault(field, 'sqlite');
      if (defaultValue && /^(current_timestamp)$/i.test(defaultValue)) builder += '.withDefault(currentDateAndTime)';
      else if (field.property.default !== undefined) {
        const raw = field.property.default;
        if (field.property.format === 'int64') builder += `.clientDefault(() => BigInt.from(${Number(raw)}))`;
        else if (field.kind === 'object' || field.kind === 'array') builder += `.withDefault(Constant(${JSON.stringify(JSON.stringify(raw))}))`;
        else {
          const literal = typeof raw === 'string' ? JSON.stringify(raw) : String(raw);
          builder += `.withDefault(const Constant(${literal}))`;
        }
      }
      lines.push(`  ${columnClass(field)} get ${dartName(field.name)} => ${builder}();`);
    }
    lines.push('', '  @override', `  Set<Column<Object>> get primaryKey => {${entity.primaryKey.map((field) => dartName(field)).join(', ')}};`, '}', '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}


export { generateDrift, generateGorm };
