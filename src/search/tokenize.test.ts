import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize, tokenizeGroups } from "./tokenize.ts";

test("keeps PascalCase identifiers whole and adds their parts", () => {
  assert.deepEqual(tokenizeGroups("IHttpClientFactory"), [["ihttpclientfactory", "http", "client", "factory"]]);
});

test("treats acronyms and digits as their own parts", () => {
  assert.deepEqual(tokenize("Utf8JsonReader"), ["utf8jsonreader", "utf", "json", "reader"]);
  assert.deepEqual(tokenize("HTTPRequest"), ["httprequest", "http", "request"]);
});

test("splits dotted names and drops stopwords", () => {
  assert.deepEqual(tokenize("Retry with Microsoft.Extensions.Http"), ["retry", "microsoft", "extensions", "http"]);
});

test("keeps language and platform names that contain punctuation", () => {
  assert.deepEqual(tokenize("C# records in ASP.NET Core on .NET 10"), [
    "csharp",
    "records",
    "aspnet",
    "core",
    "dotnet",
    "10",
  ]);
  assert.deepEqual(tokenize("F# and c#"), ["fsharp", "csharp"]);
});

test("does not treat a .Net namespace segment as the platform name", () => {
  assert.deepEqual(tokenize("System.Net.Http"), ["system", "net", "http"]);
});
