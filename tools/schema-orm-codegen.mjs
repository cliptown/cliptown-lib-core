#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fail, normalizeSchema, sha256, stableStringify } from './schema-orm/core.mjs';
import { generateDrift, generateGorm } from './schema-orm/go-dart.mjs';
import { generateEnt, generateStormberry } from './schema-orm/ent-stormberry.mjs';
import { generateDrizzle, generatePrisma, generateTypeOrm } from './schema-orm/node.mjs';
import { generateRustSeaOrm } from './schema-orm/rust.mjs';
import { generateSharedDart, generateSharedGo, generateSharedRust, generateSharedTs } from './schema-orm/shared.mjs';
import { generateSql } from './schema-orm/sql.mjs';

function generateFiles(schema) {
  const model = normalizeSchema(schema);
  const canonical = stableStringify(schema);
  const files = new Map([
    ['sql/postgres.sql', generateSql(model, 'postgres')],
    ['sql/sqlite.sql', generateSql(model, 'sqlite')],
    ['rust/sea-orm/entities.rs', generateRustSeaOrm(model)],
    ['node/drizzle/schema.ts', generateDrizzle(model)],
    ['node/prisma/schema.prisma', generatePrisma(model)],
    ['node/typeorm/entities.ts', generateTypeOrm(model)],
    ['go/gorm/models.go', generateGorm(model)],
    ['go/ent/schema/entities.go', generateEnt(model)],
    ['dart/drift/tables.dart', generateDrift(model)],
    ['dart/stormberry/models.dart', generateStormberry(model)],
    ['shared/typescript/entity-descriptors.ts', generateSharedTs(model)],
    ['shared/rust/entity_descriptors.rs', generateSharedRust(model)],
    ['shared/go/entity_descriptors.go', generateSharedGo(model)],
    ['shared/dart/entity_descriptors.dart', generateSharedDart(model)],
  ]);
  const manifest = {
    generator: 'tools/schema-orm-codegen.mjs',
    generatorVersion: 2,
    schemaDialect: schema.$schema,
    schemaId: schema.$id ?? null,
    schemaSha256: sha256(canonical),
    product: model.root.product,
    interfaces: model.root.interfaces,
    entityCount: model.entities.length,
    entityNames: model.entities.map((entity) => entity.name),
    outputs: Object.fromEntries([...files.entries()].map(([path, content]) => [path, sha256(content)])),
  };
  files.set('manifest.json', stableStringify(manifest));
  return { model, files, manifest };
}

function listFiles(root) {
  if (!existsSync(root)) return [];
  const result = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else result.push(relative(root, path));
    }
  };
  walk(root);
  return result.sort();
}

function writeGenerated(files, outputRoot) {
  rmSync(outputRoot, { recursive: true, force: true });
  for (const [path, content] of files) {
    const target = join(outputRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
}

function checkGenerated(files, outputRoot) {
  const expectedPaths = [...files.keys()].sort();
  const actualPaths = listFiles(outputRoot);
  const failures = [];
  if (JSON.stringify(expectedPaths) !== JSON.stringify(actualPaths)) {
    failures.push(`generated file set differs\nexpected: ${expectedPaths.join(', ')}\nactual: ${actualPaths.join(', ')}`);
  }
  for (const [path, content] of files) {
    const target = join(outputRoot, path);
    if (!existsSync(target)) continue;
    const current = readFileSync(target, 'utf8');
    if (current !== content) failures.push(`${path} is stale`);
  }
  if (failures.length) fail(failures.join('\n'));
}

function parseArgs(argv) {
  const args = { schema: 'schema/persistence.schema.json', out: 'generated', check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') args.check = true;
    else if (arg === '--schema') args.schema = argv[++index];
    else if (arg === '--out') args.out = argv[++index];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else fail(`unknown argument: ${arg}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node tools/schema-orm-codegen.mjs [--schema path] [--out path] [--check]');
    return;
  }
  const schemaPath = resolve(args.schema);
  const outputRoot = resolve(args.out);
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  const { files, manifest } = generateFiles(schema);
  if (args.check) checkGenerated(files, outputRoot);
  else writeGenerated(files, outputRoot);
  console.log(`${args.check ? 'verified' : 'generated'} ${manifest.entityCount} entities for ${manifest.product}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}

export {
  generateFiles,
  normalizeSchema,
  stableStringify,
};
