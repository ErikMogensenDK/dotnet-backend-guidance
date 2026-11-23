// Adapted from GoogleChrome/modern-web-guidance-src, src/rag/static-embedder.ts (Apache-2.0).
// Changes: the hyphen fallback became a PascalCase/dotted-name fallback using ./tokenize.ts groups;
// the table is passed in instead of loaded by a singleton.
//
// Embeds a query as the weighted sum of per-word vectors from a precomputed table (Model2Vec style),
// in microseconds and without a neural network. The table lives in the same vector space as the
// guide chunks, which the build embeds with the full teacher model.

import { tokenizeGroups } from "./tokenize.ts";
import { DIMS } from "./quantize.ts";
import type { QueryWords } from "./index-files.ts";

/** Anything that turns a query into a unit vector; tests can pass a fake. */
export interface Embedder {
  embed(text: string): Float32Array;
}

/**
 * Encodes text into `[wordIndex, fraction]` pairs. A word in the vocabulary counts once; an unknown
 * word falls back to its known parts ("IOptionsMonitor" → "options", "monitor"), each weighted
 * `1 / matched parts`, so the word as a whole still counts once.
 */
export function encodeTokens(text: string, wordIndex: ReadonlyMap<string, number>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [whole, ...parts] of tokenizeGroups(text)) {
    const directIdx = wordIndex.get(whole);
    if (directIdx !== undefined) {
      out.push([directIdx, 1]);
      continue;
    }
    const matched = parts.map((p) => wordIndex.get(p)).filter((idx) => idx !== undefined);
    for (const idx of matched) {
      out.push([idx, 1 / matched.length]);
    }
  }
  return out;
}

export class StaticEmbedder implements Embedder {
  private readonly wordIndex: Map<string, number>;
  private readonly model: QueryWords;

  constructor(model: QueryWords) {
    this.model = model;
    this.wordIndex = new Map(model.words.map((w, i) => [w, i]));
  }

  /** Weighted sum of the query's word vectors, L2-normalized. All zeros when no word is known. */
  embed(text: string): Float32Array {
    const out = new Float32Array(DIMS);
    for (const [i, fraction] of encodeTokens(text, this.wordIndex)) {
      const weight = this.model.scales[i] * fraction;
      const offset = i * DIMS;
      for (let k = 0; k < DIMS; k++) {
        out[k] += weight * this.model.table[offset + k];
      }
    }
    let normSq = 0;
    for (let k = 0; k < DIMS; k++) normSq += out[k] * out[k];
    const norm = Math.sqrt(normSq) || 1;
    for (let k = 0; k < DIMS; k++) out[k] /= norm;
    return out;
  }
}
