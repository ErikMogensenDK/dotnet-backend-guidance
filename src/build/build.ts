// pnpm build: guides/ → dist/data/ (search index, guide list, guide Markdown) + dist/cli.mjs.
//
// Embeddings are cached in src/build/gen/ (committed), keyed by a hash of model + task + text, so the
// embedding model only runs for new or changed chunks and words.

import fs from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";
import { chunkGuide } from "./chunk.ts";
import { computeChunkHash, loadChunkCache, saveChunkCache } from "./chunk-cache.ts";
import { loadGuides } from "./guides.ts";
import { TEACHER_MODEL, embedTexts, type EmbedTask } from "./teacher.ts";
import { writeChunkIndex, writeQueryWords } from "../search/index-files.ts";
import { tokenize } from "../search/tokenize.ts";

const root = path.resolve(import.meta.dirname, "../..");
const genDir = path.join(root, "src/build/gen");
const distDir = path.join(root, "dist");
const dataDir = path.join(distDir, "data");

/** Returns a vector for every text, embedding only the ones missing from the cache in `cacheDir`. */
async function embedCached(texts: string[], task: EmbedTask, cacheDir: string): Promise<Float32Array[]> {
  const cache = loadChunkCache(cacheDir);
  const hashes = texts.map((t) => computeChunkHash(t, TEACHER_MODEL, task));
  const missing = [...new Set(texts.filter((_, i) => !cache.has(hashes[i])))];
  if (missing.length > 0) {
    console.log(`  embedding ${missing.length} new ${task} text(s) with ${TEACHER_MODEL}…`);
    const vectors = await embedTexts(missing, task);
    missing.forEach((t, i) => cache.set(computeChunkHash(t, TEACHER_MODEL, task), vectors[i]));
  }
  // Saving only the hashes in use prunes entries for edited or deleted text.
  const used = new Map(hashes.map((h) => [h, cache.get(h)!]));
  saveChunkCache(used, cacheDir);
  return hashes.map((h) => used.get(h)!);
}

/** BM25-style IDF per word over the chunks; words in no chunk get the median IDF. */
function idfWeights(words: string[], chunkTokens: Set<string>[]): number[] {
  const n = chunkTokens.length;
  const idf = (df: number) => Math.log(1 + (n - df + 0.5) / (df + 0.5));
  const df = new Map<string, number>();
  for (const tokens of chunkTokens) for (const t of tokens) df.set(t, (df.get(t) ?? 0) + 1);
  const corpusIdfs = [...df.values()].map(idf).sort((a, b) => a - b);
  const median = corpusIdfs[Math.floor(corpusIdfs.length / 2)] ?? 1;
  return words.map((w) => (df.has(w) ? idf(df.get(w)!) : median));
}

async function main() {
  const guides = loadGuides(path.join(root, "guides"));
  console.log(`Loaded ${guides.length} guides`);

  const chunks = guides.flatMap((guide) =>
    chunkGuide(guide).map(({ chunk, embeddedText }) => ({
      id: guide.id,
      category: guide.category,
      description: guide.description,
      chunkContent: chunk,
      embeddedText,
    }))
  );
  console.log(`Chunked into ${chunks.length} chunks`);
  const chunkVectors = await embedCached(
    chunks.map((c) => c.embeddedText),
    "document",
    path.join(genDir, "chunks")
  );

  // Vocabulary: every token in the guides plus common words developers use in queries.
  const chunkTokens = chunks.map((c) => new Set(tokenize(c.embeddedText)));
  const vocabularyFile = fs.readFileSync(path.join(root, "src/build/query-vocabulary.txt"), "utf8");
  const extraWords = tokenize(vocabularyFile.replace(/^#.*$/gm, ""));
  const words = [...new Set([...chunkTokens.flatMap((s) => [...s]), ...extraWords])].sort();
  console.log(`Vocabulary: ${words.length} words`);
  const wordVectors = await embedCached(words, "query", path.join(genDir, "words"));

  fs.rmSync(distDir, { recursive: true, force: true });
  writeChunkIndex(
    dataDir,
    chunks.map(({ embeddedText: _text, ...chunk }, i) => ({ ...chunk, vector: chunkVectors[i] }))
  );
  writeQueryWords(dataDir, words, wordVectors, idfWeights(words, chunkTokens));

  fs.writeFileSync(
    path.join(dataDir, "guides.json"),
    JSON.stringify(guides.map(({ id, category, description }) => ({ id, category, description })))
  );
  fs.mkdirSync(path.join(dataDir, "guides"));
  for (const guide of guides) {
    fs.writeFileSync(path.join(dataDir, "guides", `${guide.id}.md`), guide.markdown + "\n");
  }

  await esbuild.build({
    entryPoints: [path.join(root, "src/cli/main.ts")],
    outfile: path.join(distDir, "cli.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    minify: true,
    legalComments: "none",
  });
  console.log(`Wrote ${path.relative(root, distDir)}/`);
}

await main();
