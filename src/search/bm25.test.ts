import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBm25Index, rankBm25, reciprocalRankFusion } from "./bm25.ts";

test("matches identifier parts and plurals", () => {
  const index = buildBm25Index([
    { id: "http", text: "Create clients with IHttpClientFactory." },
    { id: "ef", text: "Apply the migration." },
    { id: "logging", text: "Structured logging with ILogger." },
  ]);
  assert.deepEqual(
    rankBm25(index, "http client").map((r) => r.id),
    ["http"]
  );
  assert.deepEqual(
    rankBm25(index, "migrations").map((r) => r.id),
    ["ef"]
  );
});

test("reciprocal rank fusion sums 1 / (60 + rank) across lists", () => {
  // c: 1/63 + 1/61 ≈ 0.032266 edges out b: 1/62 + 1/62 ≈ 0.032258; a and d appear in one list each.
  const fused = reciprocalRankFusion([
    ["a", "b", "c"],
    ["c", "b", "d"],
  ]);
  assert.deepEqual(
    fused.map((r) => r.id),
    ["c", "b", "a", "d"]
  );
});

test("reciprocal rank fusion scales each list by its weight", () => {
  // Weighted 0.25, dense-only "a" (0.25/61) falls below BM25's second result "b" (1/62).
  const fused = reciprocalRankFusion([["a"], ["c", "b"]], 60, [0.25, 1]);
  assert.deepEqual(
    fused.map((r) => r.id),
    ["c", "b", "a"]
  );
});
