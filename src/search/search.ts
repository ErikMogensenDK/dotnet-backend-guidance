// Adapted from GoogleChrome/modern-web-guidance-src, src/rag/search.ts (Apache-2.0).
// Changes: data directory and embedder passed in; telemetry removed; added a BM25 score floor and a
// dense weight in the fusion, with defaults calibrated for this project's model (see SearchOptions).

import { buildBm25Index, rankBm25, reciprocalRankFusion, type Bm25Index } from "./bm25.ts";
import { loadChunkIndex, loadQueryWords, type GuideChunkWithVector } from "./index-files.ts";
import { StaticEmbedder, type Embedder } from "./static-embedder.ts";

export interface SearchResult {
  id: string;
  description: string;
  category: string;
  /** Best dense cosine similarity of any of the guide's chunks (0 when only BM25 matched). */
  similarity: number;
}

/**
 * Defaults were tuned with `pnpm bench --split=dev` (nomic-embed-text-v1.5 teacher, untrained word
 * table) and checked on `--split=test`. Re-tune them when the model, word table or guides change a lot.
 */
export interface SearchOptions {
  limit?: number;
  /**
   * A query is in scope when its best chunk cosine reaches this floor. Upstream used 0.30 for
   * gemini-embedding-001; this model's similarities sit higher, and 90% of in-scope bench queries
   * score ≥ 0.69 while unrelated ones mostly score ≤ 0.67.
   */
  minSimilarity?: number;
  /**
   * When the cosine is below the floor, BM25 alone can still admit the query, but only with a match
   * this strong. Without it, one shared common word ("best", "build") admits any query.
   */
  minBm25Score?: number;
  /**
   * Weight of the dense ranking relative to BM25 in the fusion. The static word table ranks worse
   * than BM25 on the bench, so it counts less; it still ranks paraphrases that share no words.
   */
  denseWeight?: number;
}

const DEFAULTS: Required<SearchOptions> = { limit: 10, minSimilarity: 0.72, minBm25Score: 6, denseWeight: 0.25 };

export interface SearchIndex {
  chunks: GuideChunkWithVector[];
  bm25: Bm25Index;
  embedder: Embedder;
}

/** Loads the index files written by the build from `dir` (see index-files.ts). */
export function loadSearchIndex(dir: string): SearchIndex {
  return createSearchIndex(loadChunkIndex(dir), new StaticEmbedder(loadQueryWords(dir)));
}

export function createSearchIndex(chunks: GuideChunkWithVector[], embedder: Embedder): SearchIndex {
  const bm25 = buildBm25Index(chunks.map((c) => ({ id: c.id, text: `${c.description}\n\n${c.chunkContent}` })));
  return { chunks, bm25, embedder };
}

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/**
 * Hybrid search: guides are ranked by their best-matching chunk (dense cosine) and by per-chunk
 * max-pooled BM25, then merged with weighted reciprocal rank fusion.
 *
 * Scope: if the best cosine reaches `minSimilarity`, the query is in scope and both rankings are
 * fused. Otherwise only BM25 matches scoring at least `minBm25Score` are returned, and `[]` when
 * there are none, so out-of-scope queries don't fill an agent's context with unrelated guides.
 */
export function search(index: SearchIndex, query: string, options: SearchOptions = {}): SearchResult[] {
  const { limit, minSimilarity, minBm25Score, denseWeight } = { ...DEFAULTS, ...options };
  const queryVector = index.embedder.embed(query);

  // Both sides are unit vectors, so the dot product is the cosine similarity.
  const best = new Map<string, { chunk: GuideChunkWithVector; similarity: number }>();
  for (const chunk of index.chunks) {
    if (chunk.vector.length === 0) continue;
    const similarity = dot(queryVector, chunk.vector);
    const existing = best.get(chunk.id);
    if (!existing || similarity > existing.similarity) {
      best.set(chunk.id, { chunk, similarity });
    }
  }
  const dense = [...best.values()].sort((a, b) => b.similarity - a.similarity);
  const inScope = (dense[0]?.similarity ?? 0) >= minSimilarity;
  const bm25Matches = rankBm25(index.bm25, query).filter((r) => inScope || r.score >= minBm25Score);

  if (!inScope && bm25Matches.length === 0) {
    return [];
  }

  const fused = reciprocalRankFusion(
    [inScope ? dense.map((r) => r.chunk.id) : [], bm25Matches.map((r) => r.id)],
    undefined,
    [denseWeight, 1]
  );

  return fused.slice(0, limit).map(({ id }) => {
    const r = best.get(id);
    const chunk = r ? r.chunk : index.chunks.find((c) => c.id === id)!;
    return {
      id,
      description: chunk.description,
      category: chunk.category,
      similarity: r ? Number(r.similarity.toFixed(4)) : 0,
    };
  });
}
