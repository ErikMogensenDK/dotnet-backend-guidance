// Finds and validates guides at <guidesDir>/<category>/<id>/guide.md.

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { GuideForChunking } from "./chunk.ts";

export type Guide = GuideForChunking & { keywords: string[] };

/** Loads every non-draft guide, sorted by id. Throws one error listing every invalid guide. */
export function loadGuides(guidesDir: string): Guide[] {
  const guides: Guide[] = [];
  const errors: string[] = [];

  for (const category of fs.readdirSync(guidesDir).sort()) {
    const categoryDir = path.join(guidesDir, category);
    if (!fs.statSync(categoryDir).isDirectory()) continue;
    for (const id of fs.readdirSync(categoryDir).sort()) {
      const file = path.join(categoryDir, id, "guide.md");
      if (!fs.existsSync(file)) continue;
      const where = path.relative(guidesDir, file);

      const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(fs.readFileSync(file, "utf8"));
      if (!match) {
        errors.push(`${where}: missing YAML frontmatter`);
        continue;
      }
      const data = (parseYaml(match[1]) ?? {}) as Record<string, unknown>;
      const markdown = match[2].trim();
      if (data.draft === true) continue;

      const title = /^#\s+(.+)$/m.exec(markdown)?.[1].trim();
      const keywords = data.keywords ?? [];
      if (data.name !== id) errors.push(`${where}: name "${String(data.name)}" must equal the folder name "${id}"`);
      if (typeof data.description !== "string" || !data.description.trim()) errors.push(`${where}: missing description`);
      if (!Array.isArray(keywords) || !keywords.every((k) => typeof k === "string")) {
        errors.push(`${where}: keywords must be a list of strings`);
      }
      if (!title) errors.push(`${where}: missing "# Title" heading`);
      if (guides.some((g) => g.id === id)) errors.push(`${where}: id "${id}" is already used in another category`);

      guides.push({
        id,
        category,
        title: title ?? id,
        description: String(data.description ?? "").trim(),
        markdown,
        keywords: keywords as string[],
      });
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid guides:\n  ${errors.join("\n  ")}`);
  }
  return guides.sort((a, b) => a.id.localeCompare(b.id));
}
