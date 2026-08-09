import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const schema = JSON.parse(await readFile(new URL('../schema/persistence.schema.json', import.meta.url), 'utf8'));

test('persistence contract contains ciphertext metadata only', () => {
  const persistedFieldNames = Object.values(schema.$defs)
    .filter((definition) => definition['x-db']?.table)
    .flatMap((definition) => Object.keys(definition.properties ?? {}))
    .map((field) => field.toLowerCase());
  for (const forbidden of ['plaintext', 'unwrappedkey', 'rawcontentkey', 'decryptedpayload']) {
    assert.equal(persistedFieldNames.includes(forbidden), false, `forbidden persistence field: ${forbidden}`);
  }
  assert.ok(persistedFieldNames.some((field) => field.includes('ciphertext')));
  assert.ok(persistedFieldNames.includes('wrappedkey'));
});

test('every ClipTown persisted entity is tied to a shared interface type', () => {
  for (const [name, definition] of Object.entries(schema.$defs)) {
    if (!definition['x-db']?.table) continue;
    assert.ok(definition['x-interface']?.type, `${name} has no x-interface.type`);
  }
});
