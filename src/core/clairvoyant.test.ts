import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeClairvoyant, renderClairvoyant } from "./clairvoyant.js";

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-clairvoyant-"));
  git(["init", "-q"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  git(["config", "core.autocrlf", "false"], dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "src", "math.ts"), "export function calculate(a, b) { return a + b; }\n", "utf8");
  writeFileSync(
    join(dir, "src", "math.test.ts"),
    'import { calculate } from "./math.js";\ntest("calculate", () => {});\n',
    "utf8",
  );
  writeFileSync(join(dir, "src", "util.ts"), "export const utilValue = 1;\n", "utf8");
  writeFileSync(join(dir, "src", "util.test.ts"), 'test("util", () => {});\n', "utf8");
  writeFileSync(join(dir, "src", "other.test.ts"), 'test("other", () => {});\n', "utf8");
  writeFileSync(join(dir, "docs", "readme.md"), "old\n", "utf8");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
  return dir;
}

function makeDiff(): string {
  return [
    "diff --git a/src/math.ts b/src/math.ts",
    "--- a/src/math.ts",
    "+++ b/src/math.ts",
    "@@ -1,1 +1,1 @@",
    "-export function calculate(a, b) { return a + b; }",
    "+export function calculate(a, b) { return Number(a) + Number(b); }",
    "diff --git a/src/util.ts b/src/util.ts",
    "--- a/src/util.ts",
    "+++ b/src/util.ts",
    "@@ -1,1 +1,1 @@",
    "-export const utilValue = 1;",
    "+export const utilValue = 2;",
    "diff --git a/docs/readme.md b/docs/readme.md",
    "--- a/docs/readme.md",
    "+++ b/docs/readme.md",
    "@@ -1,1 +1,1 @@",
    "-old",
    "+new",
    "",
  ].join("\n");
}

test("analyzeClairvoyant maps imports and symbols to predicted tests", () => {
  const dir = makeRepo();
  try {
    const report = analyzeClairvoyant(dir, makeDiff());
    assert.deepEqual(report.changedFiles, ["src/math.ts", "src/util.ts", "docs/readme.md"]);
    assert.ok(report.symbols.some((symbol) => symbol.name === "calculate"));

    const math = report.tests.find((entry) => entry.path === "src/math.test.ts");
    assert.ok(math);
    assert.ok(math.reasons.includes("import:src/math.ts"));
    assert.ok(math.reasons.includes("symbol:calculate"));

    const util = report.tests.find((entry) => entry.path === "src/util.test.ts");
    assert.ok(util);
    assert.ok(util.reasons.includes("name:src/util.ts"));

    assert.deepEqual(report.scope, ["src/math.test.ts"]);
    assert.match(report.summary, /\[CI SCOPE\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("analyzeClairvoyant falls back to naming candidates when nothing is predicted", () => {
  const dir = makeRepo();
  try {
    const diff = [
      "diff --git a/src/util.ts b/src/util.ts",
      "--- a/src/util.ts",
      "+++ b/src/util.ts",
      "@@ -1,1 +1,1 @@",
      "-export const utilValue = 1;",
      "+export const utilValue = 2;",
      "",
    ].join("\n");
    const report = analyzeClairvoyant(dir, diff);
    assert.deepEqual(report.scope, ["src/util.test.ts"]);
    assert.match(renderClairvoyant(report), /\[IN SCOPE\] src\/util\.test\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("analyzeClairvoyant reports an empty scope when only docs change", () => {
  const dir = makeRepo();
  try {
    const diff = [
      "diff --git a/docs/readme.md b/docs/readme.md",
      "--- a/docs/readme.md",
      "+++ b/docs/readme.md",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    const report = analyzeClairvoyant(dir, diff);
    assert.deepEqual(report.scope, []);
    assert.match(report.summary, /полный набор/);
    assert.match(renderClairvoyant(report), /Clairvoyant: 0 test/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
