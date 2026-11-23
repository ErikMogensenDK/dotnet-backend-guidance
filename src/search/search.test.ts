import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeChunkIndex, writeQueryWords } from "./index-files.ts";
import { DIMS } from "./quantize.ts";
import { loadSearchIndex, search } from "./search.ts";

/** Unit vector along the sum of the given axes, so cosines are easy to reason about. */
function axes(...indices: number[]): Float32Array {
  const v = new Float32Array(DIMS);
  for (const i of indices) v[i] = 1 / Math.sqrt(indices.length);
  return v;
}

// A tiny index written and read through the real file format: axis 0 = HTTP, 1 = retries,
// 2 = databases, 3 = schema changes, 5 = logging.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "search-test-"));
writeQueryWords(
  dir,
  ["http", "retry", "resilience", "database", "migration", "logging"],
  [axes(0), axes(1), axes(1), axes(2), axes(3), axes(5)],
  [1, 1, 1, 1, 1, 1]
);
writeChunkIndex(dir, [
  {
    id: "resilient-http",
    description: "Make outgoing HTTP calls resilient.",
    category: "resilience",
    chunkContent: "Register handlers on IHttpClientFactory clients with Microsoft.Extensions.Http.Resilience.",
    vector: axes(0, 1),
  },
  {
    id: "resilient-http",
    description: "Make outgoing HTTP calls resilient.",
    category: "resilience",
    chunkContent: "Log each attempt.",
    vector: axes(5),
  },
  {
    id: "resilient-http",
    description: "Make outgoing HTTP calls resilient.",
    category: "resilience",
    chunkContent: "A chunk that has not been embedded yet.",
    vector: [],
  },
  {
    id: "ef-migrations",
    description: "Apply EF Core migrations safely.",
    category: "data-access",
    chunkContent: "Run migrations from a bundle, not from DbContext.Database.Migrate() at startup.",
    vector: axes(2, 3),
  },
]);
const index = loadSearchIndex(dir);

test("finds a guide by meaning when no query word appears in its text", () => {
  // "retry" is in neither guide's text, only near the resilient-http chunk in vector space.
  const results = search(index, "retry");
  assert.equal(results[0]?.id, "resilient-http");
  assert.ok(results[0].similarity > 0.6 && results[0].similarity < 0.8, `cosine ≈ 0.707, got ${results[0].similarity}`);
});

test("returns each guide once, scored by its best chunk", () => {
  const results = search(index, "logging retry");
  assert.deepEqual(
    results.map((r) => r.id),
    ["resilient-http", "ef-migrations"]
  );
});

test("finds an exact identifier through BM25 when the embedder does not know it", () => {
  // The embedder knows no word of "DbContext", so only a strong enough BM25 match admits the query.
  assert.deepEqual(search(index, "DbContext", { minBm25Score: 1 }), [
    { id: "ef-migrations", description: "Apply EF Core migrations safely.", category: "data-access", similarity: 0 },
  ]);
  assert.deepEqual(search(index, "DbContext", { minBm25Score: 100 }), []);
});

test("returns nothing for an out-of-scope query", () => {
  assert.deepEqual(search(index, "best pizza in copenhagen"), []);
});

test("treats a query below the similarity floor as out of scope unless BM25 admits it", () => {
  // "retry" has cosine ≈ 0.707 with the resilient-http chunk and appears in no guide text.
  assert.equal(search(index, "retry", { minSimilarity: 0.7 })[0]?.id, "resilient-http");
  assert.deepEqual(search(index, "retry", { minSimilarity: 0.71 }), []);
});
