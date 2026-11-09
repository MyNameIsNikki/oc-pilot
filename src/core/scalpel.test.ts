import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildScalpelPrompt,
  parseScalpelHypothesis,
  renderScalpel,
  verifyScalpel,
} from "./scalpel.js";

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function makeRepo(withTest = true): string {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-scalpel-"));
  git(["init", "-q"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  git(["config", "core.autocrlf", "false"], dir);
  writeFileSync(join(dir, "app.mjs"), "export const value = 1;\n", "utf8");
  if (withTest) {
    writeFileSync(
      join(dir, "app.test.mjs"),
      [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { value } from "./app.mjs";',
        'test("value", () => { assert.equal(value, 2); });',
        "",
      ].join("\n"),
      "utf8",
    );
  }
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
  return dir;
}

function patch(value: number): string {
  return [
    "diff --git a/app.mjs b/app.mjs",
    "--- a/app.mjs",
    "+++ b/app.mjs",
    "@@ -1,1 +1,1 @@",
    "-export const value = 1;",
    `+export const value = ${String(value)};`,
    "",
  ].join("\n");
}

test("parseScalpelHypothesis accepts JSON with a patch and a reason", () => {
  const parsed = parseScalpelHypothesis('```json\n{"patch":"diff --git a/x b/x","reason":"fix"}\n```');
  assert.deepEqual(parsed, { patch: "diff --git a/x b/x", reason: "fix" });
  assert.equal(parseScalpelHypothesis("not json"), undefined);
  assert.equal(parseScalpelHypothesis('{"patch":"x"}'), undefined);
  assert.deepEqual(parseScalpelHypothesis('{"patch":"","reason":"cannot"}'), { patch: "", reason: "cannot" });
});

test("buildScalpelPrompt asks for a minimal patch and includes the failure", () => {
  const prompt = buildScalpelPrompt("1 !== 2", "diff --git a/app.mjs b/app.mjs", "off by one");
  assert.match(prompt, /smallest unified diff/);
  assert.match(prompt, /strict JSON/);
  assert.match(prompt, /1 !== 2/);
  assert.match(prompt, /off by one/);
  assert.match(prompt, /diff --git a\/app\.mjs/);
});

test("verifyScalpel accepts a minimal patch that makes the failing test pass", async () => {
  const dir = makeRepo();
  try {
    const report = await verifyScalpel(
      dir,
      "",
      { patch: patch(2), reason: "value should be 2" },
      { testCommand: "node --test app.test.mjs", timeoutMs: 20_000 },
    );
    assert.equal(report.status, "fixed", report.summary);
    assert.equal(report.tests, "pass");
    assert.match(report.summary, /\[SCALPEL FIXED\]/);
    assert.ok(report.impact);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyScalpel rejects a patch that does not fix the test", async () => {
  const dir = makeRepo();
  try {
    const report = await verifyScalpel(
      dir,
      "",
      { patch: patch(3), reason: "wrong value" },
      { testCommand: "node --test app.test.mjs", timeoutMs: 20_000 },
    );
    assert.equal(report.status, "rejected");
    assert.equal(report.tests, "fail");
    assert.match(report.summary, /\[SCALPEL REJECTED\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyScalpel applies the current diff before the fix", async () => {
  const dir = makeRepo(false);
  try {
    writeFileSync(
      join(dir, "app.test.mjs"),
      [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { value } from "./app.mjs";',
        'test("value", () => { assert.equal(value, 2); });',
        "",
      ].join("\n"),
      "utf8",
    );
    git(["add", "-N", "app.test.mjs"], dir);
    const currentDiff = git(["diff"], dir);

    const report = await verifyScalpel(
      dir,
      currentDiff,
      { patch: patch(2), reason: "value should be 2" },
      { testCommand: "node --test app.test.mjs", timeoutMs: 20_000 },
    );
    assert.equal(report.status, "fixed", report.summary);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyScalpel rejects an empty patch and reports an unverified fix without tests", async () => {
  const dir = makeRepo();
  try {
    const empty = await verifyScalpel(dir, "", { patch: "", reason: "cannot fix" }, { timeoutMs: 20_000 });
    assert.equal(empty.status, "rejected");
    assert.match(empty.summary, /не предложила патч/);

    const noTests = await verifyScalpel(dir, "", { patch: patch(2), reason: "fix" }, { runTests: false });
    assert.equal(noTests.status, "unverified");
    assert.match(noTests.summary, /\[SCALPEL UNVERIFIED\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderScalpel shows the reason, files, tests and blast radius", async () => {
  const dir = makeRepo();
  try {
    const report = await verifyScalpel(
      dir,
      "",
      { patch: patch(2), reason: "value should be 2" },
      { testCommand: "node --test app.test.mjs", timeoutMs: 20_000 },
    );
    const text = renderScalpel(report);
    assert.match(text, /Scalpel: fixed/);
    assert.match(text, /app\.mjs/);
    assert.match(text, /Tests: pass/);
    assert.match(text, /Blast radius/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
