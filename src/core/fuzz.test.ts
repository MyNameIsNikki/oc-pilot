import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { discoverFuzzTargets, renderFuzz, runFuzz } from "./fuzz.js";

function git(args: string[], cwd: string): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-fuzz-repo-"));
  git(["init", "-q"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return dir;
}

function diffFor(path: string, lines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -0,0 +1,${String(lines.length)} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

const MATH = [
  "export function add(a, b) { return a + b; }",
  'export function boom(value) { if (value === null) throw new Error("null input"); return 1; }',
  "export function spin() { while (true) {} }",
];

const IO = [
  'import { readFileSync } from "node:fs";',
  "export function readIt(path) { return readFileSync(path, \"utf8\"); }",
];

test("discoverFuzzTargets finds exports and blocks side-effect files", () => {
  const dir = makeRepo({ "src/math.mjs": `${MATH.join("\n")}\n`, "src/io.mjs": `${IO.join("\n")}\n` });
  try {
    const diff = `${diffFor("src/math.mjs", MATH)}\n${diffFor("src/io.mjs", IO)}`;
    const targets = discoverFuzzTargets(dir, diff);
    assert.deepEqual(targets.map((target) => target.name), ["add", "boom", "spin", "readIt"]);
    assert.equal(targets[0]?.arity, 2);
    assert.equal(targets[3]?.blocked, "side-effect import or call");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runFuzz reports clean, crash and timeout in separate processes", () => {
  const dir = makeRepo({ "src/math.mjs": `${MATH.join("\n")}\n` });
  try {
    const diff = diffFor("src/math.mjs", MATH);
    const inputs = [
      { label: "null", value: null },
      { label: "-1", value: -1 },
      { label: "empty string", value: "" },
    ];
    const report = runFuzz(dir, diff, {
      durationMs: 20000,
      maxTargets: 2,
      memoryMb: 128,
      inputs,
      perTargetTimeoutMs: 10000,
    });
    const byName = new Map(report.results.map((result) => [result.name, result]));
    assert.equal(byName.get("add")?.status, "clean");
    assert.equal(byName.get("boom")?.status, "crash");
    assert.ok(byName.get("boom")?.findings.some((finding) => finding.input === "null"));
    assert.equal(report.crashes, 1);
    assert.match(report.content, /\[CRASH\]/);
    assert.equal(report.exitCode, 0);
    assert.equal(
      runFuzz(dir, diff, {
        durationMs: 20000,
        maxTargets: 2,
        failOnCrash: true,
        inputs,
        perTargetTimeoutMs: 10000,
      }).exitCode,
      1,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runFuzz kills an infinite loop", () => {
  const dir = makeRepo({ "src/loop.mjs": "export function spin() { while (true) {} }\n" });
  try {
    const diff = diffFor("src/loop.mjs", ["export function spin() { while (true) {} }"]);
    const report = runFuzz(dir, diff, {
      durationMs: 3000,
      perTargetTimeoutMs: 500,
      inputs: [{ label: "null", value: null }],
    });
    assert.equal(report.results[0]?.status, "timeout");
    assert.equal(report.timeouts, 1);
    assert.match(report.content, /\[TIMEOUT\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runFuzz never executes a file with a side-effect import", () => {
  const dir = makeRepo({ "src/io.mjs": `${IO.join("\n")}\n` });
  try {
    const report = runFuzz(dir, diffFor("src/io.mjs", IO), { durationMs: 2000 });
    assert.equal(report.results[0]?.status, "blocked");
    assert.equal(report.blocked, 1);
    assert.match(renderFuzz(report), /\[BLOCKED\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
