import { spawnSync } from 'node:child_process';

import { GENERATED_HEADER, stableStringify } from './core.mjs';

function formatGo(content) {
  const result = spawnSync('gofmt', [], { input: content, encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') throw new Error('gofmt is required to generate canonical shared Go output');
  if (result.status !== 0) throw new Error(`gofmt failed: ${result.stderr || result.error || 'unknown error'}`);
  return result.stdout;
}

function descriptorData(model) {
  return model.entities.map((entity) => ({
    entity: entity.name,
    interfaceType: entity.interfaceType,
    table: entity.table,
    primaryKey: entity.primaryKey,
    requiredFields: entity.fields.filter((field) => field.required).map((field) => field.name),
  }));
}

function generateSharedTs(model) {
  const descriptors = stableStringify(descriptorData(model)).trim();
  return `// ${GENERATED_HEADER}\n\nexport type EntityDescriptor = Readonly<{\n  entity: string;\n  interfaceType: string;\n  table: string;\n  primaryKey: readonly string[];\n  requiredFields: readonly string[];\n}>;\n\nexport const entityDescriptors = ${descriptors} as const satisfies readonly EntityDescriptor[];\n\nexport function stableEntityKey(entity: string, record: Readonly<Record<string, unknown>>): string {\n  const descriptor = entityDescriptors.find((item) => item.entity === entity);\n  if (!descriptor) throw new Error(\`unknown entity: \${entity}\`);\n  return [entity, ...descriptor.primaryKey.map((field) => {\n    const value = record[field];\n    if (value === null || value === undefined || value === '') throw new Error(\`missing primary key field \${entity}.\${field}\`);\n    return encodeURIComponent(String(value));\n  })].join(':');\n}\n`;
}

function generateSharedRust(model) {
  const lines = [
    `// ${GENERATED_HEADER}`,
    '',
    '#[derive(Clone, Copy, Debug, PartialEq, Eq)]',
    'pub struct EntityDescriptor {',
    "    pub entity: &'static str,",
    "    pub interface_type: &'static str,",
    "    pub table: &'static str,",
    "    pub primary_key: &'static [&'static str],",
    "    pub required_fields: &'static [&'static str],",
    '}',
    '',
    'pub const ENTITY_DESCRIPTORS: &[EntityDescriptor] = &[',
  ];
  for (const item of descriptorData(model)) {
    lines.push('    EntityDescriptor {', `        entity: ${JSON.stringify(item.entity)},`, `        interface_type: ${JSON.stringify(item.interfaceType)},`, `        table: ${JSON.stringify(item.table)},`, `        primary_key: &[${item.primaryKey.map((value) => JSON.stringify(value)).join(', ')}],`, `        required_fields: &[${item.requiredFields.map((value) => JSON.stringify(value)).join(', ')}],`, '    },');
  }
  lines.push('];', '', 'pub fn entity_descriptor(entity: &str) -> Option<&\'static EntityDescriptor> {', '    ENTITY_DESCRIPTORS.iter().find(|candidate| candidate.entity == entity)', '}', '');
  return `${lines.join('\n')}`;
}

function generateSharedGo(model) {
  const lines = [
    `// ${GENERATED_HEADER}`,
    'package shared',
    '',
    'import (',
    '  "fmt"',
    '  "net/url"',
    '  "strings"',
    ')',
    '',
    'type EntityDescriptor struct {',
    '  Entity string',
    '  InterfaceType string',
    '  Table string',
    '  PrimaryKey []string',
    '  RequiredFields []string',
    '}',
    '',
    'var EntityDescriptors = []EntityDescriptor{',
  ];
  for (const item of descriptorData(model)) lines.push(`  {Entity: ${JSON.stringify(item.entity)}, InterfaceType: ${JSON.stringify(item.interfaceType)}, Table: ${JSON.stringify(item.table)}, PrimaryKey: []string{${item.primaryKey.map((v) => JSON.stringify(v)).join(', ')}}, RequiredFields: []string{${item.requiredFields.map((v) => JSON.stringify(v)).join(', ')}}},`);
  lines.push('}', '', 'func StableEntityKey(entity string, record map[string]any) (string, error) {', '  for _, descriptor := range EntityDescriptors {', '    if descriptor.Entity != entity { continue }', '    parts := []string{entity}', '    for _, field := range descriptor.PrimaryKey {', '      value, ok := record[field]', '      if !ok || value == nil || fmt.Sprint(value) == "" { return "", fmt.Errorf("missing primary key field %s.%s", entity, field) }', '      parts = append(parts, url.QueryEscape(fmt.Sprint(value)))', '    }', '    return strings.Join(parts, ":"), nil', '  }', '  return "", fmt.Errorf("unknown entity: %s", entity)', '}', '');
  return formatGo(`${lines.join('\n')}\n`);
}

function generateSharedDart(model) {
  const lines = [
    `// ${GENERATED_HEADER}`,
    '',
    'final class EntityDescriptor {',
    '  const EntityDescriptor({required this.entity, required this.interfaceType, required this.table, required this.primaryKey, required this.requiredFields});',
    '  final String entity;',
    '  final String interfaceType;',
    '  final String table;',
    '  final List<String> primaryKey;',
    '  final List<String> requiredFields;',
    '}',
    '',
    'const entityDescriptors = <EntityDescriptor>[',
  ];
  for (const item of descriptorData(model)) lines.push(`  EntityDescriptor(entity: ${JSON.stringify(item.entity)}, interfaceType: ${JSON.stringify(item.interfaceType)}, table: ${JSON.stringify(item.table)}, primaryKey: <String>[${item.primaryKey.map((v) => JSON.stringify(v)).join(', ')}], requiredFields: <String>[${item.requiredFields.map((v) => JSON.stringify(v)).join(', ')}]),`);
  lines.push('];', '', 'String stableEntityKey(String entity, Map<String, Object?> record) {', '  final descriptor = entityDescriptors.where((candidate) => candidate.entity == entity).firstOrNull;', "  if (descriptor == null) throw ArgumentError.value(entity, 'entity', 'unknown entity');", '  final parts = <String>[entity];', '  for (final field in descriptor.primaryKey) {', '    final value = record[field];', "    if (value == null || value.toString().isEmpty) throw ArgumentError('missing primary key field $entity.$field');", '    parts.add(Uri.encodeComponent(value.toString()));', '  }', "  return parts.join(':');", '}', '');
  return `${lines.join('\n')}`;
}

export { generateSharedDart, generateSharedGo, generateSharedRust, generateSharedTs };
