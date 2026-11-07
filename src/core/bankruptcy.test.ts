import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildBankruptcy, parseHistoryWindow } from "./bankruptcy.js";

function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-bankruptcy-"));
  git(["init", "-q"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  git(["config", "core.autocrlf", "false"], dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  return dir;
}

function commit(dir: string, message: string, date: Date): void {
  const iso = date.toISOString();
  git(["add", "."], dir);
  git(["commit", "-m", message], dir, { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });
}

test("parseHistoryWindow reads days, weeks, months and plain numbers", () => {
  assert.equal(parseHistoryWindow("30d"), 30);
  assert.equal(parseHistoryWindow("2w"), 14);
  assert.equal(parseHistoryWindow("3m"), 90);
  assert.equal(parseHistoryWindow("90"), 90);
  assert.equal(parseHistoryWindow(undefined), 90);
  assert.equal(parseHistoryWindow("0"), 1);
});

test("buildBankruptcy reports insufficient data under ten commits", () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "src", "app.ts"), "export const value = 1;\n", "utf8");
    commit(dir, "init", new Date());
    const report = buildBankruptcy(dir, { historyDays: 30 });
    assert.equal(report.insufficient, true);
    assert.equal(report.commits, 1);
    assert.match(report.content, /\[INSUFFICIENT DATA: Need at least 10 commits to compute Slop Velocity\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildBankruptcy forecasts a rising score and explains the weights", () => {
  const dir = makeRepo();
  try {
    const now = Date.now();
    for (let index = 0; index < 12; index += 1) {
      const date = new Date(now - (12 - index) * 86_400_000);
      if (index < 6) {
        writeFileSync(join(dir, "src", "app.ts"), `export const value = ${String(index)};\n`, "utf8");
      } else {
        const padding = Array.from({ length: index }, (_value, row) => `const pad${String(row)} = ${String(row)};`).join("\n");
        writeFileSync(
          join(dir, "src", "app.ts"),
          [
            "// TODO: remove the debug command",
            'const { exec } = require("child_process");',
            `export function run${String(index)}() {`,
            "  exec(req.query.cmd);",
            "  return 1;",
            "}",
            padding,
            "",
          ].join("\n"),
          "utf8",
        );
        writeFileSync(
          join(dir, "src", "app.test.ts"),
          `it.skip("run${String(index)}", () => {\n  expect(run${String(index)}()).toBe(1);\n});\n`,
          "utf8",
        );
      }
      commit(dir, `step ${String(index)}`, date);
    }

    const report = buildBankruptcy(dir, { historyDays: 30, explain: true });
    assert.equal(report.insufficient, false);
    assert.equal(report.commits, 12);
    assert.ok(report.points.length >= 10);
    assert.ok(report.slopePerDay > 0, `slope ${String(report.slopePerDay)}`);
    assert.equal(report.verdict, "forecast");
    assert.ok(report.forecastDate);
    assert.match(report.content, /0\.35 \* testWeakening/);
    assert.match(report.content, /security/);
    assert.match(report.svg, /<svg/);
    assert.match(report.svg, /<polyline/);
    assert.match(report.svg, /stroke-dasharray="4 4"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
