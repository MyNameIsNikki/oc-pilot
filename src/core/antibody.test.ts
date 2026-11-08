import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  clearAntibodies,
  forgetAntibody,
  learnAntibodies,
  listAntibodies,
  normalizeSnippet,
  scanAntibodies,
} from "./antibody.js";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-antibody-"));
  const init = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "app.ts"),
    [
      'import { db } from "./db.js";',
      "export function load(req: any) {",
      '  return db.query("SELECT * FROM users WHERE id = " + req.query.id);',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  return dir;
}

const VULNERABLE_DIFF = [
  "diff --git a/src/other.ts b/src/other.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/other.ts",
  "@@ -0,0 +1,3 @@",
  "+export function find(req: any) {",
  '+  return db.query("SELECT * FROM users WHERE id = " + req.query.id);',
  "+}",
  "",
].join("\n");

test("normalizeSnippet collapses formatting and literals", () => {
  assert.equal(
    normalizeSnippet('  db.query("SELECT 1");  '),
    'db.query("str")',
  );
});

test("learnAntibodies stores SAST findings and dedupes repeat runs", () => {
  const dir = makeRepo();
  try {
    const first = learnAntibodies(dir);
    assert.ok(first.scanned >= 1);
    assert.ok(first.findings >= 1);
    assert.ok(first.added >= 1);
    assert.ok(first.total >= 1);

    const listed = listAntibodies(dir);
    assert.ok(listed.signatures.some((signature) => signature.rule === "sql-injection"));

    const second = learnAntibodies(dir);
    assert.equal(second.added, 0);
    assert.equal(second.total, first.total);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanAntibodies flags a reintroduced vulnerability pattern", () => {
  const dir = makeRepo();
  try {
    learnAntibodies(dir);
    const report = scanAntibodies(dir, VULNERABLE_DIFF);
    assert.ok(report.matches.length >= 1);
    assert.equal(report.matches[0]?.rule, "sql-injection");
    assert.match(report.summary, /\[ANTIBODY MATCH\]/);
    assert.match(report.content, /src\/other\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanAntibodies ignores unrelated added lines", () => {
  const dir = makeRepo();
  try {
    learnAntibodies(dir);
    const diff = [
      "diff --git a/src/other.ts b/src/other.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/other.ts",
      "@@ -0,0 +1,1 @@",
      "+export const answer = 42;",
      "",
    ].join("\n");
    const report = scanAntibodies(dir, diff);
    assert.deepEqual(report.matches, []);
    assert.match(report.summary, /\[ANTIBODY CLEAN\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forgetAntibody removes one signature and clearAntibodies removes the rest", () => {
  const dir = makeRepo();
  try {
    const learned = learnAntibodies(dir);
    const listed = listAntibodies(dir);
    assert.equal(listed.signatures.length, learned.total);
    const target = listed.signatures[0]!;
    const forgotten = forgetAntibody(dir, target.id);
    assert.equal(forgotten.removed, true);
    assert.equal(forgotten.remaining, listed.signatures.length - 1);
    assert.equal(forgetAntibody(dir, target.id).removed, false);

    const cleared = clearAntibodies(dir);
    assert.equal(cleared.removed, listed.signatures.length - 1);
    assert.deepEqual(listAntibodies(dir).signatures, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
