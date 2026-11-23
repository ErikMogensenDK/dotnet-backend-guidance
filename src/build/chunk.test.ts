import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkGuide, chunkMarkdown } from "./chunk.ts";

test("splits at headings and keeps consecutive headings with the body that follows", () => {
  const markdown = "# Title\n\nIntro.\n\n## Implementation\n\n### Step 1\n\nRegister it.\n\n## Pitfalls\n\nDon't.\n";
  const chunks = chunkMarkdown(markdown).map((c) => c.replace(/\s+/g, " ").trim());
  assert.deepEqual(chunks, ["# Title Intro.", "## Implementation ### Step 1 Register it.", "## Pitfalls Don't."]);
});

test("adds a summary chunk and prefixes every chunk with the guide header", () => {
  const chunks = chunkGuide({
    id: "resilient-http",
    category: "resilience",
    title: "Resilient HTTP calls",
    description: "Retry transient failures.",
    markdown: "## Implementation\n\nUse AddStandardResilienceHandler().\n",
    keywords: ["IHttpClientFactory"],
  });
  const header = "Resilient HTTP calls\nresilient-http (resilience)\nKeywords: IHttpClientFactory\n\n";
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].embeddedText.startsWith(header + "## Implementation"));
  assert.equal(chunks[1].chunk, "# Resilient HTTP calls\n\nRetry transient failures.");
  assert.equal(chunks[1].embeddedText, header + chunks[1].chunk);
});
