# Adapt and rebuild the guidance for your own fork

Use this workflow to add your team's best practices, replace the existing guides, or adapt the tool to another domain. Run commands from the repository root: the folder containing `package.json`.

## What “retraining” means here

The current POC **does not train or fine-tune a neural network**. `pnpm build` uses an existing local embedding model to regenerate the search data:

| Part | What the build does |
| --- | --- |
| Guide embeddings | Splits each guide into sections and embeds them with `nomic-embed-text-v1.5` in document mode. |
| Query word table | Collects words from your guides and the extra vocabulary file, then embeds each word in query mode. |
| Word weights | Recomputes IDF weights: words appearing in fewer chunks get more weight. |
| Search index and CLI | Writes the compressed vectors, guide text and metadata to `dist/data/`, then bundles `dist/cli.mjs`. |

At search time, the CLI sums the query words' vectors and combines semantic ranking with keyword search (BM25). It doesn't load the embedding model or call a server.

Upstream's **Tokenlearn fitting** adjusts word vectors and weights to imitate the model's embeddings of whole queries. That training step is **not implemented in this POC**. There is no `train` command or training-query input; rebuilding is the supported way to incorporate new guidance.

## 1. Install dependencies and establish a baseline

Requires Node.js 22.18+ and pnpm. For an existing fork, pull your latest changes first.

```sh copy Copy Baseline Commands
pnpm install
pnpm build
pnpm bench --split=test
```

Keep the benchmark output for comparison after your edits. For a completely different subject, replace the benchmark queries as described in step 4 before interpreting its numbers.

The first build that needs new embeddings downloads the local model from Hugging Face (roughly 140 MB). No API key is required. Later embedding runs can use that downloaded model offline; a build where every embedding is cached doesn't load the model at all. Cached builds are quick, but generating many embeddings can take several minutes on a CPU.

## 2. Add, edit or replace guides

Each guide lives at:

```text
guides/<category>/<id>/guide.md
```

For example, `guides/services/tenant-isolation/guide.md`:

```markdown copy Copy Guide Template
---
name: tenant-isolation
description: Keep each tenant's data isolated when handling requests and running background jobs.
keywords: [TenantId, tenant isolation, multi-tenancy]
---

# Isolate tenant data

Explain the problem and the mistake this guidance prevents.

## Implementation

1. Describe the implementation steps.

## Example Code

Include an example that follows these rules.

## Best Practices & Constraints

- State the requirements and explicitly name the patterns to avoid.

## Version notes

State the target framework and package versions, and alternatives for older projects.
```

- **`name` must match the guide folder name.** IDs must be unique across categories.
- **`description` is required.** Write it as the task a developer wants to accomplish; it appears in search results.
- **`keywords` is an optional list of strings.** Use exact types, methods, packages and domain terminology. Quote entries containing commas so YAML doesn't split them into separate items.
- Include a Markdown `# Title` heading.
- Add `draft: true` to the frontmatter to omit an unfinished guide from the build.
- New category folders work without registering them in code.
- To remove a recommendation, remove its guide directory. A successful rebuild removes its index entries and prunes unused cached embeddings.

Keep rules and examples self-contained: `get` returns the guide body, not neighboring source files. For a domain beyond .NET, also review the C#-specific tokenization in [`src/search/tokenize.ts`](../src/search/tokenize.ts).

## 3. Add vocabulary developers will use

Edit [`src/build/query-vocabulary.txt`](../src/build/query-vocabulary.txt) with useful synonyms or task words that aren't in the guides. For example, users might search “flaky” while your guides say “transient failures.”

This file accepts whitespace-separated text; lines starting with `#` are comments. It adds words to the static query table, **not** mappings from queries to particular guides. Whole training sentences won't teach the current implementation phrase meaning: the tokenizer breaks them into vocabulary words and embeds those words separately.

Don't copy held-out benchmark queries into this file to improve scores. Add vocabulary based on your domain or independently collected developer language, not the evaluation answers.

## 4. Update the benchmark for your content

Edit [`bench/queries.jsonl`](../bench/queries.jsonl), with one JSON object per line:

```json copy Copy Benchmark Examples
{"query":"prevent cross tenant data leaks","expected":["tenant-isolation"]}
{"query":"tenant context in background job","expected":["tenant-isolation"]}
{"query":"center a div with css","expected":[]}
```

Use several independently phrased queries per guide, including exact API names, paraphrases and realistic out-of-scope requests. Update expected IDs after removing or renaming guides. `expected: []` means the catalog should not answer that query.

The benchmark currently splits **alternating lines**: the first, third, etc. are `dev`; the second, fourth, etc. are `test`. Put both relevant and out-of-scope queries in each half. Use dev for tuning and test for the final report; don't keep changing settings to improve test scores. This small POC split doesn't guarantee independent topics or guides between halves, so its results are a useful check, not a production-quality evaluation.

## 5. Rebuild and try the results

```sh copy Copy Rebuild Commands
pnpm build
node dist/cli.mjs list
node dist/cli.mjs search "prevent cross tenant data leaks"
node dist/cli.mjs get tenant-isolation
pnpm bench --split=dev
```

The search and get examples assume you added the template guide above. Substitute your actual task and guide ID otherwise.

The build automatically:

1. Validates and chunks your non-draft guides.
2. Embeds only new or changed chunk text and vocabulary words.
3. Recomputes weights across the current corpus.
4. Prunes cache entries no longer in use.
5. Replaces `dist/` with the new index, guides and bundled CLI.

You don't need to delete caches for normal guide or vocabulary changes. If you use `npm link`, the linked command picks up the rebuilt CLI without linking again.

## 6. Recalibrate search when the corpus changes

The similarity distribution and keyword scores depend on your content and embedding model. Test different settings against dev without editing code:

```sh copy Copy Calibration Command
pnpm bench --split=dev --min-similarity=0.70 --min-bm25=6 --dense-weight=0.25
```

| Option | Effect |
| --- | --- |
| `--min-similarity` | The best chunk cosine must reach this floor to admit the semantic ranking. Higher is stricter. |
| `--min-bm25` | If semantic similarity misses the floor, only keyword matches scoring at least this amount are returned. |
| `--dense-weight` | Contribution of semantic ranking relative to keyword ranking in rank fusion. |

**The similarity floor is per query, not per result.** Once the best chunk passes, lower-similarity guides can still appear among the results.

Compare Hit@1, Hit@5 and out-of-scope admission, then set your chosen defaults in [`src/search/search.ts`](../src/search/search.ts) under `DEFAULTS`. Run:

```sh copy Copy Final Evaluation
pnpm build
pnpm bench --split=test
pnpm typecheck
pnpm lint
pnpm test
```

Rebuilding is necessary after changing search code because the installed command uses the bundled `dist/cli.mjs`. Benchmarks import the source directly, so they can otherwise disagree with a stale CLI.

## 7. Know what to commit and reset

Commit your guides, extra vocabulary, benchmark queries, any search-setting changes, and **all six cache files** under `src/build/gen/chunks/` and `src/build/gen/words/`. The generated `dist/` directory stays untracked and is recreated by the build.

| Location | Purpose | When to reset |
| --- | --- | --- |
| `src/build/gen/chunks/` | Cached document embeddings keyed by model, task, dimensions and exact text | Usually never; edits invalidate entries automatically. |
| `src/build/gen/words/` | Cached query-word embeddings keyed the same way | Usually never; vocabulary additions and removals are automatic. |
| `dist/` | Index and CLI used at runtime | Automatically replaced by every build. |
| Downloaded Hugging Face model | ONNX model files used only to generate embeddings | Separate from the generated-vector caches; clearing the latter doesn't require a model download if it is still available locally. |

**Force full regeneration only when needed**, such as changing the embedding preprocessing while keeping the same model name. The cache key doesn't include the implementation of preprocessing, task prefixes or model revision, so those changes require clearing both generated-vector cache folders. Keep your changes committed first if you want to restore the old caches.

PowerShell (Windows):

```powershell copy Copy PowerShell Cache Reset
Remove-Item -Recurse -Force src/build/gen/chunks, src/build/gen/words
pnpm build
```

Bash (Linux/macOS):

```sh copy Copy Bash Cache Reset
rm -rf src/build/gen/chunks src/build/gen/words
pnpm build
```

These commands delete only reproducible embedding caches, not your guides. A full regeneration takes longer and needs the embedding model available locally or downloadable.

## Changing the embedding model or the fork's identity

For a model change, update [`src/build/teacher.ts`](../src/build/teacher.ts): model ID, task prefixes, supported ONNX dtype, pooling and normalization must follow the new model's instructions. Both document and query embeddings must be in the **same model's vector space**. Arbitrarily truncating a model's vectors to 256 dimensions is not valid unless the model supports it. If you change `DIMS` in [`src/search/quantize.ts`](../src/search/quantize.ts), clear both generated-vector caches before building: the existing cache reader expects the current dimension count.

Rebuild all affected embeddings and recalibrate search after a model change. Don't keep the old similarity floor just because it worked for Nomic.

For a renamed fork, also update package/bin names and repository URLs in `package.json`, the plugin and marketplace manifests, the skill's scope and command examples, and the root README. The skill uses the locally linked command; build and run `npm link` in your fork so the agent can find it on PATH. Changing guides alone does not update that agent integration.

Retain the Apache-2.0 license and applicable attribution in `NOTICE` for the code copied from Modern Web Guidance. See [BUILD.md](BUILD.md) for the build's implementation walkthrough.
