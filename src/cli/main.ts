#!/usr/bin/env node
// The dotnet-backend-guidance CLI, for developers and coding agents. Provides search/get/list,
// adapted from Modern Web Guidance (GoogleChrome/modern-web-guidance-src, src/cli/modern-web.ts).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSearchIndex, search } from "../search/search.ts";

// Agent hosts such as Claude Code and Codex truncate long tool output (around 10 KB); bigger
// get output is written to a file the agent can read instead.
const MAX_INLINE_STDOUT_BYTES = 9500;

const USAGE = `Usage: dotnet-backend-guidance <command> [args]

Commands:
  search <query>     Find guides for a task, e.g. search "retry flaky http calls"
  get <ids>          Print guides by id (comma or space separated)
  list               List all guides
`;

/** Bundled: dist/cli.mjs next to dist/data. Source: src/cli/main.ts reads the built dist/data. */
function resolveDataDir(): string {
  for (const dir of [path.join(import.meta.dirname, "data"), path.join(import.meta.dirname, "../../dist/data")]) {
    if (fs.existsSync(path.join(dir, "guides.json"))) return dir;
  }
  throw new Error("Search index not found. Run `pnpm build` first.");
}

interface GuideEntry {
  id: string;
  category: string;
  description: string;
}

function compactJson(entries: { id: string; description: string }[]): string {
  return "[" + entries.map(({ id, description }) => JSON.stringify({ id, description })).join(",\n") + "]";
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  const arg = rest.join(" ").trim();
  if (!command || command === "-h" || command === "--help") {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }

  const dataDir = resolveDataDir();

  if (command === "search") {
    if (!arg) {
      console.error('No search query provided. Example: search "validate request body"');
      return 1;
    }
    const results = search(loadSearchIndex(dataDir), arg);
    console.log(compactJson(results));
    if (results.length === 0) {
      console.error('No matching guides. Rephrase with the concrete concept (e.g. "jwt authentication", "ef core migrations") or run `list`.');
    }
    return 0;
  }

  if (command === "list") {
    const guides: GuideEntry[] = JSON.parse(fs.readFileSync(path.join(dataDir, "guides.json"), "utf8"));
    console.log(compactJson(guides));
    return 0;
  }

  if (command === "get") {
    // Tolerate "a,b", "a b" and stray quotes from shell-escaped agent calls.
    const ids = [...new Set(arg.split(/[\s,;]+/).map((id) => id.replace(/^["'\\]+|["'\\]+$/g, "")).filter(Boolean))];
    if (ids.length === 0) {
      console.error("No guide ids provided. Run `search` first to find them.");
      return 1;
    }
    let exitCode = 0;
    const sections: string[] = [];
    for (const id of ids) {
      const file = path.join(dataDir, "guides", `${path.basename(id)}.md`);
      if (!fs.existsSync(file)) {
        console.error(`Unknown guide id "${id}". Use an id returned by \`search\` or \`list\`.`);
        exitCode = 1;
        continue;
      }
      sections.push(`--- Guide for ${id} ---\n${fs.readFileSync(file, "utf8")}`);
    }
    const output = sections.join("\n");
    if (Buffer.byteLength(output) > MAX_INLINE_STDOUT_BYTES && !fs.fstatSync(1).isFile()) {
      const file = path.join(os.tmpdir(), `mbg-guide-${process.pid}-${Date.now()}.md`);
      fs.writeFileSync(file, output);
      console.log(`The guides are ${Buffer.byteLength(output)} bytes, too long to print without truncation.`);
      console.log(`Read the whole file with your file-reading tool: ${file}`);
    } else if (output) {
      console.log(output);
    }
    return exitCode;
  }

  console.error(`Unknown command "${command}".\n`);
  process.stderr.write(USAGE);
  return 1;
}

process.exitCode = main(process.argv.slice(2));
