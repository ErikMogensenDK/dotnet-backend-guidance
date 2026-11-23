import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadGuides } from "./guides.ts";

function writeGuide(root: string, category: string, id: string, content: string) {
  fs.mkdirSync(path.join(root, category, id), { recursive: true });
  fs.writeFileSync(path.join(root, category, id, "guide.md"), content);
}

test("every guide in the repository is valid", () => {
  const guides = loadGuides(path.resolve(import.meta.dirname, "../../guides"));
  assert.ok(guides.length > 0);
});

test("parses frontmatter, title and category, and skips drafts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guides-test-"));
  writeGuide(root, "api", "health-checks", "---\nname: health-checks\ndescription: Expose health endpoints.\nkeywords: [MapHealthChecks]\n---\n\n# Health checks\n\nBody.\n");
  writeGuide(root, "api", "unfinished", "---\nname: unfinished\ndescription: Later.\ndraft: true\n---\n\n# Unfinished\n");

  assert.deepEqual(loadGuides(root), [
    {
      id: "health-checks",
      category: "api",
      title: "Health checks",
      description: "Expose health endpoints.",
      markdown: "# Health checks\n\nBody.",
      keywords: ["MapHealthChecks"],
    },
  ]);
});

test("reports every invalid guide at once", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guides-test-"));
  writeGuide(root, "api", "renamed", "---\nname: old-name\ndescription: Something.\n---\n\n# Renamed\n");
  writeGuide(root, "services", "no-description", "---\nname: no-description\n---\n\n# No description\n");
  writeGuide(root, "services", "renamed", "---\nname: renamed\ndescription: Duplicate id.\n---\n\n# Duplicate\n");

  assert.throws(() => loadGuides(root), (error: Error) => {
    assert.match(error.message, /api[/\\]renamed[/\\]guide\.md: name "old-name" must equal the folder name "renamed"/);
    assert.match(error.message, /no-description[/\\]guide\.md: missing description/);
    assert.match(error.message, /services[/\\]renamed[/\\]guide\.md: id "renamed" is already used/);
    return true;
  });
});
