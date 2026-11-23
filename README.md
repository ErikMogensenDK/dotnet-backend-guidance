# Dotnet Backend Guidance

Curated best practices for C#/.NET backend development (ASP.NET Core APIs, the service layer, and EF Core data access), searchable locally and offline by developers and coding agents. Modeled on Google's [Modern Web Guidance](https://github.com/GoogleChrome/modern-web-guidance-src); see [docs/modern-web-guidance-architecture.html](docs/modern-web-guidance-architecture.html).

## Why have a local search?

This project turns a collection of .NET backend guides into a searchable reference for you and your coding agent. Describe the task, such as "validate an API request" or "check permissions before loading data", and the CLI finds relevant guides. Read the matching guides for implementation steps, example code, constraints and version notes before making changes.

Instead of relying only on a model's training data or putting every rule into a large instruction file, the agent can look up the guidance it needs for the current task:

- **Focused context:** Search returns short descriptions first; the agent reads only the guides it chooses, rather than loading the whole collection into its context.
- **Consistent decisions:** Developers and agents use the same written patterns. You can edit or add guides to capture your team's conventions, then rebuild the index.
- **Local and offline:** Search queries stay on your machine. Searching needs no API key, hosted search service or running language model; the search data is precomputed during the build.
- **Easy to inspect:** The source of the advice is ordinary Markdown, not a generated answer. You can review it, version it and update it when your practices change.

The tool does not generate code or enforce rules. It gives developers and agents a small, relevant reference to work from; the result still needs review and testing.

## Usage

`search` returns the ten best matching guides as `[{ "id", "description" }]`, and `get` prints guides by id. Search runs on your machine with no network access or API keys: it combines keyword ranking (BM25) with semantic similarity from a precomputed word-vector table.

`dbg` is a shorter name for `dotnet-backend-guidance`; both run the same CLI. After setup, use `dbg search "<query>"`, `dbg get <guide-id>` or `dbg list`. 

## Setup
1. Clone/fork the repository to local machine
(The agent must have access to the same machine and PATH or you can copy the skill directory into your agent's skill location)

2. Either tell your agent:
'Use the instructions in skill.md to set up the dotnet-backend-guidance skill'
or

- Run `pnpm build` from root
- Run `npm link` 

Add the SKILL.md to your agent-skills.
Now you (and your agent) can run 'dotnet-backend-guidance search "<search-string>"' to search for relevant skills, and 'dotnet-backend-guidance get "<skill-id>"'

### In coding agents

[`skills/dotnet-backend-guidance/SKILL.md`](skills/dotnet-backend-guidance/SKILL.md) tells an agent to search for guides and read them with `get` before writing backend code. 

The skill instructs the model to  use the local commands:

'dotnet-backend-guidance search "<search-string>"'
'dotnet-backend-guidance get "<skill-id>"'

To inform its code-generation.

## Develop

Requires Node.js 22.18+ (TypeScript runs natively, no compile step) and pnpm.

```sh
pnpm install
pnpm build       # guides/ → dist/data (search index) + dist/cli.mjs
pnpm bench       # search quality on bench/queries.jsonl (--split=dev to tune, --split=test to report)
pnpm test        # node --test on src/**/*.test.ts
pnpm preflight   # typecheck + lint + test
```

`pnpm build` embeds guide chunks and vocabulary words with a local model (`nomic-embed-text-v1.5` via transformers.js, downloaded once from Hugging Face). Embeddings are cached in `src/build/gen/` and committed, so builds only run the model for new or changed text.

## Add your own best practices

See [the retraining and fork guide](docs/RETRAINING.md) for adding or replacing guides, regenerating embeddings and vocabulary, benchmarking search quality, and tuning the similarity floor. It also explains what the current POC rebuilds and how that differs from training a model.

The search and build code is adapted from Modern Web Guidance (Apache-2.0); see [NOTICE](NOTICE).
