import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeTokens } from "./static-embedder.ts";

test("uses a known identifier as one word", () => {
  const vocab = new Map([["ioptionsmonitor", 0], ["options", 1], ["monitor", 2]]);
  assert.deepEqual(encodeTokens("IOptionsMonitor", vocab), [[0, 1]]);
});

test("falls back to the known parts of an unknown identifier, splitting its weight", () => {
  const vocab = new Map([["options", 0], ["monitor", 1], ["reload", 2]]);
  assert.deepEqual(encodeTokens("IOptionsMonitor reload", vocab), [
    [0, 0.5],
    [1, 0.5],
    [2, 1],
  ]);
});
