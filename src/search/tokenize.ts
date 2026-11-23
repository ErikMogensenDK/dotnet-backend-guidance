// Shared by BM25 (search/bm25.ts), the static query embedder (search/static-embedder.ts) and the
// build, so queries and guides are always tokenized the same way.
// Replaces the web tokenizer of GoogleChrome/modern-web-guidance-src (src/rag/bm25.ts, Apache-2.0),
// which kept hyphenated CSS names whole; C# needs identifier splitting and language aliases instead.

const STOPWORDS = new Set(
  "the a an and or of to in for with on by is are be as it this that from at use using your you can how when which into not"
    .split(" ")
);

/** Rewrites names whose punctuation the word regex would lose, such as "C#" and ".NET". */
const ALIASES: Array<[RegExp, string]> = [
  [/\bc#/gi, " csharp "],
  [/\bf#/gi, " fsharp "],
  [/\basp\.net\b/gi, " aspnet "],
  // ".NET" only as a standalone word, so "System.Net.Http" stays a namespace.
  [/(^|[^A-Za-z0-9])\.net\b/gi, "$1 dotnet "],
];

/**
 * Splits text into groups of lowercase tokens, one group per word: the whole word first, then its
 * PascalCase/camelCase parts when it has more than one ("IHttpClientFactory" →
 * ["ihttpclientfactory", "http", "client", "factory"]). Dotted names split at the dots.
 * Stopwords and single-character tokens are dropped.
 *
 * The static embedder uses the grouping to embed a word by its parts when the whole word is not in
 * its vocabulary.
 */
export function tokenizeGroups(text: string): string[][] {
  let normalized = text;
  for (const [pattern, replacement] of ALIASES) {
    normalized = normalized.replace(pattern, replacement);
  }

  const groups: string[][] = [];
  for (const word of normalized.match(/[A-Za-z0-9]+/g) ?? []) {
    const whole = word.toLowerCase();
    if (whole.length < 2 || STOPWORDS.has(whole)) continue;
    const parts = (word.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g) ?? [])
      .map((p) => p.toLowerCase())
      .filter((p) => p.length > 1 && !STOPWORDS.has(p));
    groups.push(parts.length > 1 ? [whole, ...parts] : [whole]);
  }
  return groups;
}

/** All tokens of `text`: each word and its parts, as one flat list. */
export function tokenize(text: string): string[] {
  return tokenizeGroups(text).flat();
}
