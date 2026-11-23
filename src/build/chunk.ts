// Adapted from GoogleChrome/modern-web-guidance-src, src/core/guide-chunks.ts (Apache-2.0).
// Changes: web feature IDs in the chunk header replaced by free-form keywords (such as C# type and
// package names); frontmatter parsing and macro expansion left to the caller.

import { marked } from "marked";

export interface GuideForChunking {
  id: string;
  category: string;
  title: string;
  description: string;
  /** Guide Markdown body without frontmatter. */
  markdown: string;
  /** Exact identifiers to boost in search, such as ["IHttpClientFactory", "Microsoft.Extensions.Http.Resilience"]. */
  keywords?: string[];
}

export interface EmbeddableChunk {
  /** The chunk's own Markdown, used for BM25 and stored in the index. */
  chunk: string;
  /** Header + chunk: the exact text to send to the embedding model. */
  embeddedText: string;
}

/** Splits Markdown at headings, keeping consecutive headings without body text together. */
export function chunkMarkdown(markdown: string): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let hasBody = false;

  for (const token of marked.lexer(markdown)) {
    if (token.type === "heading" && current.length > 0 && hasBody) {
      chunks.push(current.join("\n\n"));
      current = [];
      hasBody = false;
    }
    current.push(token.raw);
    if (token.type !== "heading" && token.type !== "space") {
      hasBody = true;
    }
  }
  if (current.length > 0) {
    chunks.push(current.join("\n\n"));
  }
  return chunks.filter((chunk) => chunk.trim().length > 0);
}

/**
 * The header prepended to every chunk before embedding. It ties each chunk to its guide and puts
 * exact identifiers into every chunk, which keeps their lexical recall high.
 */
export function formatChunkHeader(guide: GuideForChunking): string {
  const header = `${guide.title}\n${guide.id} (${guide.category})`;
  return guide.keywords?.length ? `${header}\nKeywords: ${guide.keywords.join(", ")}` : header;
}

/** One chunk per heading section plus a summary chunk (title + description), each with the header. */
export function chunkGuide(guide: GuideForChunking): EmbeddableChunk[] {
  const header = formatChunkHeader(guide);
  const summary = `# ${guide.title}\n\n${guide.description}`;
  return [...chunkMarkdown(guide.markdown), summary].map((chunk) => ({
    chunk,
    embeddedText: `${header}\n\n${chunk}`,
  }));
}
