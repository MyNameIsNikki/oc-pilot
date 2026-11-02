import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeTestDelta, describeTestDelta } from "./test-delta.js";

function diffWithAdded(file: string, addedLines: number): string {
  const added = Array.from({ length: addedLines }, (_, index) => `+line ${index}`).join("\n");
  return `diff --git a/${file} b/${file}
+++ b/${file}
@@ -1 +1,${addedLines} @@
${added}
`;
}

test("flags logic-only changes above the threshold", () => {
  const delta = analyzeTestDelta(["src/wallet.ts"], diffWithAdded("src/wallet.ts", 25));
  assert.equal(delta.gap, true);
  assert.equal(delta.addedCodeLines, 25);
  assert.deepEqual(delta.codeFiles, ["src/wallet.ts"]);
  assert.deepEqual(delta.testFiles, []);
});

test("no gap when tests changed too", () => {
  const diff = diffWithAdded("src/wallet.ts", 40);
  const delta = analyzeTestDelta(["src/wallet.ts", "src/wallet.test.ts"], diff);
  assert.equal(delta.gap, false);
  assert.deepEqual(delta.testFiles, ["src/wallet.test.ts"]);
});

test("no gap below the threshold", () => {
  const delta = analyzeTestDelta(["src/wallet.ts"], diffWithAdded("src/wallet.ts", 10));
  assert.equal(delta.gap, false);
  assert.equal(delta.addedCodeLines, 10);
});

test("no gap for docs-only changes", () => {
  const delta = analyzeTestDelta(["README.md"], diffWithAdded("README.md", 40));
  assert.equal(delta.gap, false);
  assert.deepEqual(delta.codeFiles, []);
});

test("describeTestDelta mentions line count and files", () => {
  const delta = analyzeTestDelta(["src/wallet.ts"], diffWithAdded("src/wallet.ts", 25));
  const text = describeTestDelta(delta);
  assert.ok(text.includes("+25"));
  assert.ok(text.includes("src/wallet.ts"));
});
