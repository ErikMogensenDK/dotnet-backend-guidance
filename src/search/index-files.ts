// Reads and writes the search index files, so the build (writer) and the CLI (reader) share one format.
// Format from GoogleChrome/modern-web-guidance-src, src/rag/search.ts and src/rag/train-query-words.ts
// (Apache-2.0). Changes: readers and writers combined in one module, data directory passed in.
//
// <dir>/guide-chunks.json.gz    gzipped JSON array of GuideChunk (one entry per chunk, no vectors)
// <dir>/guide-chunks.i8         Int8 matrix, one DIMS-wide row per chunk
// <dir>/guide-chunks.scale.f32  Float32 per-row scale (0 = chunk has no vector; BM25 only)
// <dir>/query-words.json        JSON array of vocabulary words
// <dir>/query-words.i8          Int8 matrix, one DIMS-wide row per word
// <dir>/query-words.scale.f32   Float32 per-word weight × row scale

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { DIMS, dequantizeVectorRow, quantizeVectors, toAlignedFloat32Array, toInt8Array } from "./quantize.ts";

export interface GuideChunk {
  /** Guide ID, such as "resilient-http-calls". Several chunks share one ID. */
  id: string;
  description: string;
  category: string;
  /** Markdown text of the chunk; feeds the BM25 index. */
  chunkContent: string;
}

export interface GuideChunkWithVector extends GuideChunk {
  /** Unit vector of length DIMS, or empty when the chunk has no embedding yet. */
  vector: ArrayLike<number>;
}

export interface QueryWords {
  words: string[];
  /** Int8 rows of unit word vectors. */
  table: Int8Array;
  /** Per-word weight multiplied by the row's quantization scale. */
  scales: Float32Array;
}

function writeMatrix(basePath: string, vectors: Array<ArrayLike<number>>, weights?: ArrayLike<number>): void {
  const { qTable, scales } = quantizeVectors(vectors, DIMS);
  if (weights) {
    for (let i = 0; i < scales.length; i++) scales[i] *= weights[i];
  }
  fs.writeFileSync(`${basePath}.i8`, qTable);
  fs.writeFileSync(`${basePath}.scale.f32`, new Uint8Array(scales.buffer));
}

function readMatrix(basePath: string, rows: number): { table: Int8Array; scales: Float32Array } {
  const table = toInt8Array(fs.readFileSync(`${basePath}.i8`));
  const scales = toAlignedFloat32Array(fs.readFileSync(`${basePath}.scale.f32`));
  if (table.length !== rows * DIMS || scales.length !== rows) {
    throw new Error(`Corrupt index files ${basePath}.*: expected ${rows} rows of ${DIMS} dimensions`);
  }
  return { table, scales };
}

export function writeChunkIndex(dir: string, chunks: GuideChunkWithVector[]): void {
  fs.mkdirSync(dir, { recursive: true });
  const metadata: GuideChunk[] = chunks.map(({ vector: _vector, ...chunk }) => chunk);
  fs.writeFileSync(path.join(dir, "guide-chunks.json.gz"), zlib.gzipSync(JSON.stringify(metadata)));
  writeMatrix(
    path.join(dir, "guide-chunks"),
    chunks.map((c) => c.vector)
  );
}

export function loadChunkIndex(dir: string): GuideChunkWithVector[] {
  const metadata: GuideChunk[] = JSON.parse(
    zlib.gunzipSync(fs.readFileSync(path.join(dir, "guide-chunks.json.gz"))).toString("utf8")
  );
  const { table, scales } = readMatrix(path.join(dir, "guide-chunks"), metadata.length);
  return metadata.map((chunk, i) => ({ ...chunk, vector: dequantizeVectorRow(table, scales, i, DIMS) }));
}

/**
 * Writes the static query-embedding table. `vectors[i]` should be a unit vector for `words[i]`;
 * `weights[i]` scales its contribution to a query vector (for example, its IDF).
 */
export function writeQueryWords(
  dir: string,
  words: string[],
  vectors: Array<ArrayLike<number>>,
  weights: ArrayLike<number>
): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "query-words.json"), JSON.stringify(words));
  writeMatrix(path.join(dir, "query-words"), vectors, weights);
}

export function loadQueryWords(dir: string): QueryWords {
  const words: string[] = JSON.parse(fs.readFileSync(path.join(dir, "query-words.json"), "utf8"));
  return { words, ...readMatrix(path.join(dir, "query-words"), words.length) };
}
