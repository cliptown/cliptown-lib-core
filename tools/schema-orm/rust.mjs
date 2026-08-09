import { GENERATED_HEADER, fail, pascalCase, rustName, snakeCase } from './core.mjs';

function rustScalar(field) {
  if (field.kind === 'string') {
    if (field.property.format === 'uuid') return 'Uuid';
    if (field.property.format === 'date-time') return 'DateTimeWithTimeZone';
    return 'String';
  }
  if (field.kind === 'integer') return field.property.format === 'int32' ? 'i32' : 'i64';
  if (field.kind === 'number') return 'f64';
  if (field.kind === 'boolean') return 'bool';
  if (field.kind === 'object' || field.kind === 'array') return 'Json';
  fail(`unsupported Rust type for ${field.name}`);
}

function generateRustSeaOrm(model) {
  const lines = [
    `// ${GENERATED_HEADER}`,
    '#![allow(clippy::module_inception)]',
    '',
  ];
  for (const entity of model.entities) {
    const relationFields = entity.fields.filter((field) => field.db.references);
    lines.push(`pub mod ${entity.module} {`, '    use sea_orm::entity::prelude::*;', '');
    if (entity.description) lines.push(`    /// ${entity.description.replaceAll('\n', ' ')}`);
    lines.push('    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]', `    #[sea_orm(table_name = "${entity.table}")]`, '    pub struct Model {');
    for (const field of entity.fields) {
      const attrs = [];
      if (entity.primaryKey.includes(field.name)) attrs.push('primary_key', 'auto_increment = false');
      if (field.kind === 'object' || field.kind === 'array') attrs.push('column_type = "JsonBinary"');
      if (field.column !== snakeCase(field.name)) attrs.push(`column_name = "${field.column}"`);
      if (attrs.length) lines.push(`        #[sea_orm(${attrs.join(', ')})]`);
      const type = field.nullable ? `Option<${rustScalar(field)}>` : rustScalar(field);
      lines.push(`        pub ${rustName(field.name)}: ${type},`);
    }
    lines.push('    }', '', '    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]');
    if (relationFields.length === 0) {
      lines.push('    pub enum Relation {}');
    } else {
      lines.push('    pub enum Relation {');
      const counts = new Map();
      for (const field of relationFields) counts.set(field.db.references.entity, (counts.get(field.db.references.entity) ?? 0) + 1);
      for (const field of relationFields) {
        const ref = field.db.references;
        const target = model.entityMap.get(ref.entity);
        const variant = counts.get(ref.entity) > 1 ? pascalCase(`${ref.entity}_${field.name}`) : pascalCase(ref.entity);
        lines.push('        #[sea_orm(', `            belongs_to = "super::${target.module}::Entity",`, `            from = "Column::${pascalCase(field.name)}",`, `            to = "super::${target.module}::Column::${pascalCase(ref.field)}"`, '        )]', `        ${variant},`);
      }
      lines.push('    }', '');
      for (const field of relationFields) {
        const ref = field.db.references;
        if (counts.get(ref.entity) > 1) continue;
        const target = model.entityMap.get(ref.entity);
        const variant = pascalCase(ref.entity);
        lines.push(`    impl Related<super::${target.module}::Entity> for Entity {`, '        fn to() -> RelationDef {', `            Relation::${variant}.def()`, '        }', '    }', '');
      }
      for (const [targetName, count] of counts) {
        if (count > 1) lines.push(`    // ${count} foreign keys point to ${targetName}; use Relation variants explicitly.`, '');
      }
    }
    lines.push('    impl ActiveModelBehavior for ActiveModel {}', '}', '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}


export { generateRustSeaOrm };
