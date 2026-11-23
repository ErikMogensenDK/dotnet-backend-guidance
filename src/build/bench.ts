// pnpm bench: measures search quality on bench/queries.jsonl against the built index in dist/data.
//
//   --split=dev|test   use every other query (dev: 1st, 3rd, …; test: 2nd, 4th, …). Tune search
//                      defaults on dev and report test, so the numbers aren't fitted to the queries.
//   --min-similarity=, --min-bm25=, --dense-weight=   override the SearchOptions defaults.
//
// Hit@1 / Hit@5: share of in-scope queries with an expected guide first / in the top five.
// Out-of-scope admitted: share of queries with `expected: []` that returned any result.
// Keep these queries out of anything the build learns from.

import fs from "node:fs";
import path from "node:path";
import { loadSearchIndex, search, type SearchOptions } from "../search/search.ts";

const root = path.resolve(import.meta.dirname, "../..");
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const split = arg("split");
const number = (name: string) => (arg(name) === undefined ? undefined : Number(arg(name)));
const options: SearchOptions = {
  minSimilarity: number("min-similarity"),
  minBm25Score: number("min-bm25"),
  denseWeight: number("dense-weight"),
};
for (const key of Object.keys(options) as (keyof SearchOptions)[]) if (options[key] === undefined) delete options[key];

const index = loadSearchIndex(path.join(root, "dist/data"));
const queries: { query: string; expected: string[] }[] = fs
  .readFileSync(path.join(root, "bench/queries.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line))
  .filter((_, i) => (split === "dev" ? i % 2 === 0 : split === "test" ? i % 2 === 1 : true));

const inScope = queries.filter((q) => q.expected.length > 0);
const outOfScope = queries.filter((q) => q.expected.length === 0);
const pct = (n: number, d: number) => `${((100 * n) / d).toFixed(1)}%`;

let hit1 = 0;
let hit5 = 0;
const misses: string[] = [];
for (const { query, expected } of inScope) {
  const ids = search(index, query, options).map((r) => r.id);
  if (expected.includes(ids[0])) hit1++;
  if (ids.slice(0, 5).some((id) => expected.includes(id))) hit5++;
  else misses.push(`  "${query}" → expected ${expected.join(" | ")}, got ${ids.slice(0, 3).join(", ") || "[]"}`);
}
const admitted = outOfScope.filter((q) => search(index, q.query, options).length > 0);

console.log(`${split ?? "all"}: ${inScope.length} in-scope and ${outOfScope.length} out-of-scope queries ${JSON.stringify(options)}`);
console.log(`Hit@1 ${pct(hit1, inScope.length)}   Hit@5 ${pct(hit5, inScope.length)}   out-of-scope admitted ${pct(admitted.length, outOfScope.length)}`);
if (misses.length) console.log(`Not in top 5:\n${misses.join("\n")}`);
if (admitted.length) console.log(`Out-of-scope queries that returned results:\n  ${admitted.map((q) => q.query).join("\n  ")}`);
