import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeChunkHash, loadChunkCache, saveChunkCache } from "./chunk-cache.ts";
import { DIMS, l2Normalize } from "../search/quantize.ts";

test("the hash changes with the model, the task, and the text", () => {
  const base = computeChunkHash("text", "model-a", "document");
  assert.notEqual(computeChunkHash("text", "model-b", "document"), base);
  assert.notEqual(computeChunkHash("text", "model-a", "query"), base);
  assert.notEqual(computeChunkHash("text.", "model-a", "document"), base);
  assert.equal(computeChunkHash("text", "model-a", "document"), base);
});

test("vectors survive Int8 quantization with cosine above 0.999", () => {
  const original = l2Normalize(Float32Array.from({ length: DIMS }, (_, i) => Math.sin(i * 1.7) * (i % 7)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chunk-cache-test-"));
  saveChunkCache(new Map([["hash-1", original]]), dir);

  const restored = loadChunkCache(dir).get("hash-1")!;
  const cosine = original.reduce((sum, x, i) => sum + x * restored[i], 0);
  assert.ok(cosine > 0.999, `cosine was ${cosine}`);
});
