import assert from "node:assert/strict";
import test from "node:test";
import { parsePublic, safeParsePublic } from "../dist/public.js";

const validProblem = { type: "urn:test", title: "Invalid request", status: 400, requestId: "req-1" };

test("preserves exact request metadata", () => {
  const value = { requestId: " req-1 ", traceId: " trace-1 ", locale: "en" };
  assert.deepEqual(parsePublic("request-meta", value), value);
});

test("accepts public boundaries", () => {
  assert.equal(safeParsePublic("request-meta", { requestId: "r".repeat(128), traceId: "t".repeat(128), locale: "l".repeat(64) }).success, true);
  assert.deepEqual(parsePublic("page-query", { limit: 1 }), { limit: 1 });
  assert.deepEqual(parsePublic("page-query", { limit: 100, cursor: "c".repeat(512) }), { limit: 100, cursor: "c".repeat(512) });
  assert.equal(safeParsePublic("problem-details", { ...validProblem, status: 599, detail: "d".repeat(4096) }).success, true);
});

for (const [schema, name, value] of [
  ["request-meta", "missing trace id", { requestId: "req-1" }],
  ["request-meta", "empty request id", { requestId: "", traceId: "trace-1" }],
  ["request-meta", "oversized request id", { requestId: "r".repeat(129), traceId: "trace-1" }],
  ["request-meta", "short locale", { requestId: "req-1", traceId: "trace-1", locale: "e" }],
  ["request-meta", "oversized locale", { requestId: "req-1", traceId: "trace-1", locale: "l".repeat(65) }],
  ["request-meta", "client identity", { requestId: "req-1", traceId: "trace-1", userId: "client-supplied" }],
  ["page-query", "missing limit", {}],
  ["page-query", "zero limit", { limit: 0 }],
  ["page-query", "oversized limit", { limit: 101 }],
  ["page-query", "fractional limit", { limit: 1.5 }],
  ["page-query", "empty cursor", { limit: 50, cursor: "" }],
  ["page-query", "oversized cursor", { limit: 50, cursor: "c".repeat(513) }],
  ["page-query", "unknown field", { limit: 50, offset: 1 }],
  ["problem-details", "status below range", { ...validProblem, status: 399 }],
  ["problem-details", "status above range", { ...validProblem, status: 600 }],
  ["problem-details", "fractional status", { ...validProblem, status: 400.5 }],
  ["problem-details", "empty title", { ...validProblem, title: "" }],
  ["problem-details", "oversized detail", { ...validProblem, detail: "d".repeat(4097) }],
  ["problem-details", "unknown server field", { ...validProblem, internalCode: "secret" }],
]) {
  test(`rejects ${schema} with ${name}`, () => assert.equal(safeParsePublic(schema, value).success, false));
}
