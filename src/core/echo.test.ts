import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildEcho, type EchoFetch } from "./echo.js";
import { recordApiCall, recordRun } from "./stats.js";

function git(args: string[], cwd: string): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-echo-"));
  git(["init", "-q"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  git(["config", "core.autocrlf", "false"], dir);
  writeFileSync(join(dir, "app.ts"), "export const value = 1;\n", "utf8");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
  return dir;
}

test("buildEcho builds local badges from stats and git", async () => {
  const dir = makeRepo();
  try {
    recordRun(dir, {
      recipe: "review",
      engine: "test",
      exitCode: 0,
      findings: { critical: 1, warning: 2, style: 0 },
    });
    recordApiCall(dir, { model: "test-model", cached: true, durationMs: 10 });
    const report = await buildEcho(dir, { name: "tester", sinceDays: 30 });
    assert.equal(report.name, "tester");
    assert.equal(report.sinceDays, 30);
    assert.equal(report.badges.length, 6);
    assert.equal(report.stats.commits, 1);
    assert.equal(report.stats.runs, 1);
    assert.equal(report.stats.apiCalls, 1);
    assert.equal(report.stats.cacheHits, 1);
    assert.equal(report.stats.findings, 3);
    assert.equal(report.submitted, false);
    assert.match(report.content, /<svg/);
    assert.match(report.content, /tester/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildEcho submits only the aggregate payload", async () => {
  const dir = makeRepo();
  try {
    let url = "";
    let body = "";
    const fetchImpl: EchoFetch = async (target, init) => {
      url = target;
      body = init.body;
      return { ok: true, status: 200, text: async () => "ok" };
    };
    const report = await buildEcho(dir, {
      name: "tester",
      sinceDays: 7,
      submit: true,
      endpoint: "https://example.com/echo",
      fetchImpl,
    });
    assert.equal(report.submitted, true);
    assert.match(report.submissionStatus ?? "", /^ok 200/);
    assert.equal(url, "https://example.com/echo");
    assert.match(body, /"name":"tester"/);
    assert.match(body, /"stats"/);
    assert.ok(!body.includes("app.ts"), "payload must not contain file paths");
    assert.ok(!body.includes("src/"), "payload must not contain file paths");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildEcho requires an endpoint for submit", async () => {
  const dir = makeRepo();
  try {
    await assert.rejects(
      buildEcho(dir, { name: "tester", submit: true }),
      /endpoint/i,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
