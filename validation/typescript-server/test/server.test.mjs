import assert from "node:assert/strict";
import test from "node:test";
import { InternalCommandSchema, ServerRequestContextSchema, TrustedActorSchema } from "../dist/server.js";

const actor = { userId: "user-1", tenantId: "tenant-1", roles: ["reader"] };
const context = { requestId: "req-1", traceId: "trace-1", actor, sourceIp: "127.0.0.1" };

test("accepts bounded server values", () => {
  assert.deepEqual(TrustedActorSchema.parse(actor), actor);
  assert.deepEqual(ServerRequestContextSchema.parse(context), context);
  const command = { operationId: "clips.create", idempotencyKey: "idem-1", context, payload: {} };
  assert.deepEqual(InternalCommandSchema.parse(command), command);
});

test("preserves exact trusted identity", () => {
  const value = { userId: " user-1 ", roles: [] };
  assert.deepEqual(TrustedActorSchema.parse(value), value);
});

for (const [schema, name, value] of [
  [TrustedActorSchema, "empty user", { userId: "", roles: [] }],
  [TrustedActorSchema, "oversized user", { userId: "u".repeat(129), roles: [] }],
  [TrustedActorSchema, "empty role", { userId: "user-1", roles: [""] }],
  [TrustedActorSchema, "too many roles", { userId: "user-1", roles: Array.from({ length: 65 }, () => "reader") }],
  [TrustedActorSchema, "unknown actor field", { userId: "user-1", roles: [], token: "secret" }],
  [ServerRequestContextSchema, "invalid source IP", { ...context, sourceIp: "not-an-ip" }],
  [ServerRequestContextSchema, "invalid nested metadata", { ...context, requestId: "" }],
  [ServerRequestContextSchema, "client identity", { ...context, userId: "client-supplied" }],
  [InternalCommandSchema, "missing operation", { context, payload: {} }],
  [InternalCommandSchema, "empty operation", { operationId: "", context, payload: {} }],
  [InternalCommandSchema, "oversized operation", { operationId: "o".repeat(257), context, payload: {} }],
  [InternalCommandSchema, "oversized idempotency key", { operationId: "clips.create", idempotencyKey: "i".repeat(129), context, payload: {} }],
  [InternalCommandSchema, "unknown command field", { operationId: "clips.create", context, payload: {}, credential: "secret" }],
]) {
  test(`rejects server value with ${name}`, () => assert.equal(schema.safeParse(value).success, false));
}
