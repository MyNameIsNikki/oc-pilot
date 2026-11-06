import assert from "node:assert/strict";
import test from "node:test";
import { analyzeMockLeaks, describeMockLeaks } from "./mock-leak.js";

const DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,2 +1,8 @@",
  " const existing = 1;",
  '+const home = "C:\\\\Users\\\\aleyn\\\\project";',
  '+const token = "sk_test_123";',
  "+if (true) {",
  "+  run();",
  "+}",
  "+const mockUser = { id: 1 };",
  "+// TODO: remove mock before release",
  '+const url = "http://localhost:3000";',
  "",
].join("\n");

test("analyzeMockLeaks finds hardcoded paths, tokens, conditions and mocks", () => {
  const report = analyzeMockLeaks(DIFF);
  assert.equal(report.counts.total, 6);
  assert.equal(report.counts.high, 3);
  assert.equal(report.counts.medium, 2);
  assert.equal(report.counts.low, 1);
  assert.equal(report.status, "fail");
  assert.deepEqual(
    report.findings.map((finding) => `${finding.kind}:${String(finding.line)}`),
    [
      "local-path:2",
      "test-token:3",
      "always-true:4",
      "mock-identifier:7",
      "mock-comment:8",
      "localhost-url:9",
    ],
  );
});

test("analyzeMockLeaks skips test files and generated files", () => {
  const diff = [
    "diff --git a/src/app.test.ts b/src/app.test.ts",
    "--- a/src/app.test.ts",
    "+++ b/src/app.test.ts",
    "@@ -1,1 +1,3 @@",
    "+const mockUser = { id: 1 };",
    "+if (true) {",
    "+const token = \"sk_test_123\";",
    "diff --git a/dist/app.js b/dist/app.js",
    "--- a/dist/app.js",
    "+++ b/dist/app.js",
    "@@ -1,1 +1,2 @@",
    '+const home = "C:\\\\Users\\\\aleyn\\\\project";',
    "",
  ].join("\n");
  const report = analyzeMockLeaks(diff);
  assert.equal(report.counts.total, 0);
  assert.equal(report.status, "pass");
});

test("analyzeMockLeaks flags always-false conditions and warns without high findings", () => {
  const diff = [
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,1 +1,3 @@",
    "+if (false) {",
    "+  unreachable();",
    "+}",
    "",
  ].join("\n");
  const report = analyzeMockLeaks(diff);
  assert.equal(report.counts.high, 1);
  assert.equal(report.findings[0]?.kind, "always-false");
  assert.equal(report.status, "fail");
});

test("describeMockLeaks lists findings and caps the list", () => {
  const report = analyzeMockLeaks(DIFF);
  const text = describeMockLeaks(report.findings);
  assert.match(text, /src\/app\.ts:2 \[local-path\]/);
  assert.match(text, /src\/app\.ts:3 \[test-token\]/);
  assert.match(describeMockLeaks([]), /не найдено/);
});
