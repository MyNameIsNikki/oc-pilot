import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeArchDiff, describeArchDiff, renderMermaid } from "./arch-diff.js";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-arch-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), 'import { c } from "./c";\n\nexport const a = c;\n', "utf8");
  writeFileSync(join(dir, "src", "b.ts"), "export const b = 1;\n", "utf8");
  writeFileSync(join(dir, "src", "c.ts"), "export const c = 1;\n", "utf8");
  return dir;
}

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  '-import { c } from "./c";',
  '+import { b } from "./b";',
  " ",
  " export const a = c;",
  "",
].join("\n");

test("analyzeArchDiff reports added and removed internal imports", () => {
  const dir = makeRepo();
  try {
    const report = analyzeArchDiff(dir, DIFF);
    assert.equal(report.added.length, 1);
    assert.equal(report.removed.length, 1);
    assert.equal(report.added[0]?.from, "src/a.ts");
    assert.equal(report.added[0]?.to, "src/b.ts");
    assert.equal(report.removed[0]?.to, "src/c.ts");
    assert.deepEqual(report.nodes, ["src/a.ts", "src/b.ts", "src/c.ts"]);
    assert.match(report.diagram, /flowchart LR/);
    assert.match(report.diagram, /-->\\|added\\|/);
    assert.match(report.diagram, /-\\.->\\|removed\\|/);
    assert.match(report.diagram, /classDef added/);
    assert.match(report.diagram, /classDef removed/);
    assert.match(renderMermaid(report), /^```mermaid/);
    assert.match(describeArchDiff(report), /1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("analyzeArchDiff ignores package imports", () => {
  const dir = makeRepo();
  try {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,1 +1,2 @@",
      '+import { readFileSync } from "node:fs";',
      " export const a = 1;",
      "",
    ].join("\n");
    const report = analyzeArchDiff(dir, diff);
    assert.deepEqual(report.added, []);
    assert.deepEqual(report.removed, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("analyzeArchDiff caps the number of edges", () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "src", "d.ts"), "export const d = 1;\n", "utf8");
    writeFileSync(join(dir, "src", "e.ts"), "export const e = 1;\n", "utf8");
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,1 +1,3 @@",
      '+import { b } from "./b";',
      '+import { d } from "./d";',
      '+import { e } from "./e";',
      "",
    ].join("\n");
    const report = analyzeArchDiff(dir, diff, { maxEdges: 1 });
    assert.equal(report.added.length, 1);
    assert.equal(report.truncated, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
