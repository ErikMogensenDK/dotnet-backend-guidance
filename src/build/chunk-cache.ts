// Adapted from GoogleChrome/modern-web-guidance-src, src/rag/guide-chunk-cache.ts (Apache-2.0).
// Changes: the embedding model and task are parameters instead of gemini-embedding-001 constants.
//
// A cache of chunk embeddings keyed by a hash of exactly what was embedded, so a build only calls the
// embedding model for new or changed chunks. Commit the cache files so builds without an API key
// still produce full vectors.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DIMS, dequantizeVectorRow, quantizeVectors, toAlignedFloat32Array, toInt8Array } from "../search/quantize.ts";

/**
 * SHA-256 of model + task + dimensions + text. Changing any of them, including the chunk header or
 * guide prose, produces a new hash and therefore a new embedding.
 */
export function computeChunkHash(embeddedText: string, model: string, task: string, dims = DIMS): string {
  return crypto.createHash("sha256").update(`${model}\n${task}\n${dims}\n${embeddedText}`).digest("hex");
}

/** Loads `chunk-cache.{json,i8,scale.f32}` from `dir` as hash → unit vector; empty if absent. */
export function loadChunkCache(dir: string): Map<string, Float32Array> {
  const jsonPath = path.join(dir, "chunk-cache.json");
  if (!fs.existsSync(jsonPath)) {
    return new Map();
  }
  const hashes: string[] = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const qTable = toInt8Array(fs.readFileSync(path.join(dir, "chunk-cache.i8")));
  const scales = toAlignedFloat32Array(fs.readFileSync(path.join(dir, "chunk-cache.scale.f32")));
  if (qTable.length !== hashes.length * DIMS || scales.length !== hashes.length) {
    throw new Error(`Chunk cache in ${dir} is corrupt: expected ${hashes.length} rows of ${DIMS} dimensions`);
  }
  return new Map(hashes.map((hash, i) => [hash, dequantizeVectorRow(qTable, scales, i, DIMS)]));
}

/**
 * Writes the cache sorted by hash, so unchanged content gives byte-identical files. Entries missing
 * from `cache` are dropped, which is how stale chunks are pruned.
 */
export function saveChunkCache(cache: Map<string, ArrayLike<number>>, dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const hashes = [...cache.keys()].sort();
  const { qTable, scales } = quantizeVectors(hashes.map((h) => cache.get(h)!), DIMS);
  fs.writeFileSync(path.join(dir, "chunk-cache.json"), JSON.stringify(hashes, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "chunk-cache.i8"), qTable);
  fs.writeFileSync(path.join(dir, "chunk-cache.scale.f32"), new Uint8Array(scales.buffer));
}
