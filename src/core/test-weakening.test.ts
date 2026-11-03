import assert from "node:assert/strict";
import test from "node:test";
import { analyzeTestWeakness, describeTestWeakening } from "./test-weakening.js";

function makeDiff(file: string, body: string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,1 +1,${body.length} @@`,
    ...body,
  ].join("\n");
}

test("flags skipped and focused tests in added lines", () => {
  const diff = makeDiff("tests/wallet.test.ts", [
    '+  it.skip("withdraws", () => {})',
    '+  describe.only("deposits", () => {})',
    '+  xit("legacy path", () => {})',
  ]);
  const findings = analyzeTestWeakness(diff);
  assert.deepEqual(findings.map((finding) => finding.kind), [
    "skipped-test",
    "focused-test",
    "skipped-test",
  ]);
  assert.deepEqual(findings.map((finding) => finding.line), [1, 2, 3]);
  assert.equal(findings[0]?.file, "tests/wallet.test.ts");
});

test("flags removed assertions that were not replaced", () => {
  const diff = makeDiff("src/wallet.spec.ts", [
    "-  expect(balance).toBe(0)",
    "-  expect(history).toHaveLength(2)",
    "+  // TODO verify balance",
  ]);
  const findings = analyzeTestWeakness(diff).filter((finding) => finding.kind === "removed-assertions");
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.detail ?? "", /удалено проверок: 2/);
});

test("does not flag assertions that were rewritten", () => {
  const diff = makeDiff("src/wallet.spec.ts", [
    "-  expect(balance).toBe(0)",
    "+  expect(balance).toBe(0.0)",
  ]);
  assert.deepEqual(analyzeTestWeakness(diff), []);
});

test("flags commented-out assertions and raised timeouts", () => {
  const diff = makeDiff("__tests__/pay.test.js", [
    "+  // expect(result).toBe(42)",
    "+  jest.setTimeout(30000)",
    "+  setTimeout(500)",
  ]);
  const findings = analyzeTestWeakness(diff);
  assert.deepEqual(findings.map((finding) => finding.kind), [
    "commented-assertion",
    "raised-timeout",
  ]);
});

test("ignores non-test files and unchanged assertions", () => {
  const diff = makeDiff("src/runner.ts", [
    "+  it.skip(\"not a test\", () => {})",
    "+  // expect(nothing)",
  ]);
  assert.deepEqual(analyzeTestWeakness(diff), []);

  const untouched = makeDiff("tests/app.test.ts", ["+  it(\"works\", () => {})"]);
  assert.deepEqual(analyzeTestWeakness(untouched), []);
});

test("describeTestWeakening lists findings and caps the list", () => {
  const findings = Array.from({ length: 12 }, (_, index) => ({
    file: "tests/a.test.ts",
    line: index + 1,
    kind: "skipped-test" as const,
    detail: "тест помечен как .skip",
  }));
  const text = describeTestWeakening(findings);
  const lines = text.split("\n");
  assert.equal(lines.length, 11);
  assert.match(lines[0] ?? "", /tests\/a\.test\.ts:1 \[skipped-test\]/);
  assert.match(text, /…и ещё 2/);
});
