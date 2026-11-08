import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildSkepticPrompt,
  parseSkepticHypothesis,
  parseSkepticTimeout,
  renderSkeptic,
  runSkeptic,
  type SkepticReport,
} from "./skeptic.js";

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function makeRepo(): { dir: string; diff: string } {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-skeptic-"));
  git(["init", "-q"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  git(["config", "core.autocrlf", "false"], dir);
  writeFileSync(join(dir, "app.mjs"), "export const value = 1;\n", "utf8");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
  writeFileSync(join(dir, "app.mjs"), "export const value = 2;\n", "utf8");
  const diff = git(["diff", "--", "app.mjs"], dir);
  return { dir, diff };
}

function hypothesis(assertion: string): { test: string; reason: string } {
  return {
    test: [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { value } from "../app.mjs";',
      `test("value", () => { assert.equal(value, ${assertion}); });`,
      "",
    ].join("\n"),
    reason: `value should be ${assertion}`,
  };
}

test("parseSkepticHypothesis accepts strict JSON and rejects incomplete output", () => {
  assert.deepEqual(parseSkepticHypothesis('```json\n{"test":"x","reason":"y"}\n```'), { test: "x", reason: "y" });
  assert.equal(parseSkepticHypothesis("not json"), undefined);
  assert.equal(parseSkepticHypothesis('{"test":"","reason":"y"}'), undefined);
  assert.equal(parseSkepticHypothesis('{"test":"x"}'), undefined);
});

test("buildSkepticPrompt asks for one executable Node test and includes the diff", () => {
  const prompt = buildSkepticPrompt("diff --git a/x b/x", "checkout flow");
  assert.match(prompt, /node:test/);
  assert.match(prompt, /node:assert\/strict/);
  assert.match(prompt, /strict JSON/);
  assert.match(prompt, /checkout flow/);
  assert.match(prompt, /diff --git a\/x b\/x/);
});

test("renderSkeptic shows status, hypothesis and output", () => {
  const report: SkepticReport = {
    source: "staged",
    status: "bug",
    summary: "[SKEPTIC BUG]",
    hypothesis: { test: "x", reason: "value is wrong" },
    testFile: ".oc-pilot/skeptic.test.mjs",
    testOutput: "boom",
    durationMs: 12,
  };
  const text = renderSkeptic(report);
  assert.match(text, /Skeptic: bug/);
  assert.match(text, /value is wrong/);
  assert.match(text, /boom/);
});

test("parseSkepticTimeout accepts seconds and milliseconds", () => {
  assert.equal(parseSkepticTimeout(undefined), undefined);
  assert.equal(parseSkepticTimeout("120s"), 120_000);
  assert.equal(parseSkepticTimeout("500ms"), 500);
  assert.throws(() => parseSkepticTimeout("soon"), /Некорректный таймаут/);
});

test("runSkeptic reports a clean hypothesis when the test passes on the diff", async () => {
  const repo = makeRepo();
  try {
    const report = await runSkeptic(repo.dir, repo.diff, hypothesis("2"), { timeoutMs: 20_000 });
    assert.equal(report.status, "clean", report.summary);
    assert.equal(report.testFile, ".oc-pilot/skeptic.test.mjs");
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("runSkeptic confirms a bug when the test fails on the diff and passes on HEAD", async () => {
  const repo = makeRepo();
  try {
    const report = await runSkeptic(repo.dir, repo.diff, hypothesis("1"), { timeoutMs: 20_000 });
    assert.equal(report.status, "bug", report.summary);
    assert.match(report.summary, /\[SKEPTIC BUG\]/);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("runSkeptic calls a test that fails on both trees unfalsifiable", async () => {
  const repo = makeRepo();
  try {
    const report = await runSkeptic(repo.dir, repo.diff, hypothesis("999"), { timeoutMs: 20_000 });
    assert.equal(report.status, "unfalsifiable", report.summary);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});
