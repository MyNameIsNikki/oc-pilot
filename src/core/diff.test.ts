import assert from "node:assert/strict";
import { test } from "node:test";
import { collectChangedFiles, collectDiffStats, splitDiffBlocks, truncateDiff, truncateText } from "./diff.js";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,3 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  "diff --git a/src/b.go b/src/b.go",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/b.go",
  "@@ -0,0 +1,2 @@",
  "+package b",
  "+",
  "",
].join("\n");

test("splitDiffBlocks extracts paths", () => {
  const blocks = splitDiffBlocks(DIFF);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]?.path, "src/a.ts");
  assert.equal(blocks[1]?.path, "src/b.go");
});

test("collectDiffStats counts files and lines", () => {
  const stats = collectDiffStats(DIFF);
  assert.equal(stats.files, 2);
  assert.equal(stats.additions, 4);
  assert.equal(stats.deletions, 1);
});

test("collectChangedFiles returns unique change paths", () => {
  assert.deepEqual(collectChangedFiles(DIFF), ["src/a.ts", "src/b.go"]);
});

test("stats count added content that starts with ++ or --", () => {
  const diff = [
    "diff --git a/notes.txt b/notes.txt",
    "--- a/notes.txt",
    "+++ b/notes.txt",
    "@@ -1,1 +1,4 @@",
    " keep",
    "+++ heading",
    "+++ second",
    "--- separator",
    "",
  ].join("\n");

  const stats = collectDiffStats(diff);
  assert.equal(stats.additions, 2);
  assert.equal(stats.deletions, 1);
});

test("parseGitPath handles quoted paths", async () => {
  const { parseGitPath } = await import("./diff.js");
  assert.equal(parseGitPath('"b/src/with space.ts"'), "src/with space.ts");
  assert.equal(parseGitPath("b/src/plain.ts"), "src/plain.ts");
});

test("truncateDiff respects the budget and keeps every file header", () => {
  const big = Array.from({ length: 4 }, (_, file) =>
    [
      `diff --git a/src/file${file}.ts b/src/file${file}.ts`,
      "--- a/src/file.ts",
      `+++ b/src/file${file}.ts`,
      "@@ -1,1 +1,40 @@",
      ...Array.from({ length: 40 }, (_, line) => `+const line${line} = "${"x".repeat(40)}";`),
      "",
    ].join("\n"),
  ).join("");

  const result = truncateDiff(big, 3_000);
  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= 3_300);
  for (let file = 0; file < 4; file += 1) {
    assert.ok(result.text.includes(`file${file}.ts`));
  }
  assert.match(result.text, /обрезан/);
});

test("truncateDiff returns input untouched below the limit", () => {
  const result = truncateDiff(DIFF, 10_000);
  assert.equal(result.truncated, false);
  assert.equal(result.text, DIFF);
});

test("truncateText head, tail and both modes keep markers", () => {
  const value = `${"H".repeat(500)}${"M".repeat(500)}${"T".repeat(500)}`;
  const head = truncateText(value, 200, { mode: "head" });
  assert.ok(head.truncated);
  assert.ok(head.text.startsWith("H"));
  assert.ok(!head.text.includes("T".repeat(20)));

  const tail = truncateText(value, 200, { mode: "tail" });
  assert.ok(tail.truncated);
  assert.ok(tail.text.endsWith("T"));

  const both = truncateText(value, 300, { mode: "both" });
  assert.ok(both.text.includes("H"));
  assert.ok(both.text.includes("T"));
  assert.match(both.text, /обрезано/);
});
