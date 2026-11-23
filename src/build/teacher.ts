// The build-time embedding model ("teacher"). It embeds guide chunks and vocabulary words into the
// shared 256-dimension space; the search runtime never loads it.
//
// nomic-embed-text-v1.5 runs locally through transformers.js (ONNX), so builds need no API key. The
// model (~140 MB, Apache-2.0) downloads from Hugging Face on first use and is cached afterwards.

import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { DIMS, l2Normalize } from "../search/quantize.ts";

export const TEACHER_MODEL = "nomic-ai/nomic-embed-text-v1.5";

export type EmbedTask = "document" | "query";

// nomic-embed-text-v1.5 expects these task prefixes.
const PREFIX: Record<EmbedTask, string> = { document: "search_document: ", query: "search_query: " };

let extractor: Promise<FeatureExtractionPipeline> | undefined;

/**
 * Matryoshka truncation as nomic documents it: layer-normalize the full embedding, keep the first
 * DIMS values, then L2-normalize.
 */
function toMatryoshka(full: number[]): Float32Array {
  const mean = full.reduce((sum, x) => sum + x, 0) / full.length;
  const std = Math.sqrt(full.reduce((sum, x) => sum + (x - mean) ** 2, 0) / full.length + 1e-5);
  return l2Normalize(Float32Array.from(full.slice(0, DIMS), (x) => (x - mean) / std));
}

/**
 * Embeds texts in batches; returns unit vectors of length DIMS in the same order. A batch is padded to
 * its longest text and attention memory grows with length squared, so long document chunks use
 * small batches (32 chunks at once needed more than 4 GB of RAM).
 */
export async function embedTexts(texts: string[], task: EmbedTask, batchSize = task === "document" ? 4 : 64): Promise<Float32Array[]> {
  extractor ??= pipeline("feature-extraction", TEACHER_MODEL, { dtype: "q8" });
  const model = await extractor;
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize).map((t) => PREFIX[task] + t);
    const tensor = await model(batch, { pooling: "mean", normalize: false });
    out.push(...(tensor.tolist() as number[][]).map(toMatryoshka));
  }
  return out;
}
