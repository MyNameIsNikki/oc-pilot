import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeChronos, renderChronos } from "./chronos.js";

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function makeRepo(): { dir: string; fixSha: string } {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-chronos-"));
  git(["init", "-q"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  git(["config", "core.autocrlf", "false"], dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "src", "app.ts"), "export const value = 1;\n", "utf8");
  writeFileSync(join(dir, "docs", "notes.md"), "notes\n", "utf8");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);

  writeFileSync(join(dir, "src", "app.ts"), "export const value = 2;\n", "utf8");
  git(["add", "."], dir);
  git(["commit", "-m", "fix: handle expired token"], dir);
  const fixSha = git(["rev-parse", "HEAD"], dir).trim();

  writeFileSync(join(dir, "src", "app.ts"), "export const value = 3;\n", "utf8");
  git(["add", "."], dir);
  git(["commit", "-m", "incident: production outage on login"], dir);

  writeFileSync(join(dir, "src", "app.ts"), "export const value = 4;\n", "utf8");
  git(["add", "."], dir);
  git(["commit", "-m", "security: escape user input"], dir);

  writeFileSync(join(dir, "src", "app.ts"), "export const value = 5;\n", "utf8");
  git(["add", "."], dir);
  git(["commit", "-m", 'Revert "incident: production outage on login"'], dir);
  return { dir, fixSha };
}

test("analyzeChronos scores fixes, incidents, security and reverts as a hotspot", () => {
  const repo = makeRepo();
  try {
    const report = analyzeChronos(repo.dir, "src/app.ts");
    assert.ok(report.totals.commits >= 4);
    assert.ok(report.totals.fixes >= 1);
    assert.ok(report.totals.reverts >= 1);
    assert.ok(report.totals.incidents >= 2);
    assert.ok(report.totals.security >= 1);
    assert.ok(report.score >= 10);
    assert.equal(report.hotspot, true);
    assert.match(report.summary, /\[HOTSPOT\]/);
    assert.match(renderChronos(report), /Recent:/);
    assert.match(renderChronos(report), /fix: handle expired token/);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("analyzeChronos limits history and treats a quiet file as stable", () => {
  const repo = makeRepo();
  try {
    const limited = analyzeChronos(repo.dir, "src/app.ts", { limit: 1 });
    assert.equal(limited.commits.length, 1);

    const quiet = analyzeChronos(repo.dir, "docs/notes.md");
    assert.equal(quiet.hotspot, false);
    assert.match(quiet.summary, /\[CHRONOS\]/);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("analyzeChronos counts antibodies and vaccines linked to the file history", () => {
  const repo = makeRepo();
  try {
    const base = analyzeChronos(repo.dir, "src/app.ts");
    mkdirSync(join(repo.dir, ".oc-pilot"), { recursive: true });
    writeFileSync(
      join(repo.dir, ".oc-pilot", "antibodies.json"),
      JSON.stringify({
        version: 1,
        signatures: [
          {
            id: "ab_test",
            rule: "sql-injection",
            severity: "high",
            message: "x",
            snippet: "db.query(req.query.id)",
            normalized: "db.query(req.query.id)",
            file: "src/app.ts",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    writeFileSync(
      join(repo.dir, ".oc-pilot", "vaccines.json"),
      JSON.stringify({
        version: 1,
        vaccines: [
          {
            id: "vac_test",
            createdAt: "2026-01-01T00:00:00.000Z",
            bug: base.commits[base.commits.length - 1]?.sha,
            fix: base.commits[0]?.sha,
            testFile: ".oc-pilot/vaccines/vac_test.test.mjs",
            command: "node --test {file}",
            reason: "regression",
          },
        ],
      }),
      "utf8",
    );

    const report = analyzeChronos(repo.dir, "src/app.ts");
    assert.equal(report.antibodies, 1);
    assert.equal(report.vaccines, 1);
    assert.ok(report.score > base.score);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});
