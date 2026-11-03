import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import type { AnalysisFinding } from "../types.js";
import {
  lastReviewPath,
  loadLastReview,
  matchFindings,
  parseTarget,
  saveLastReview,
} from "./last-review.js";

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-last-review-"));
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(dir, "README.md"), "# repo\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "init"]);
  return dir;
}

const FINDINGS: AnalysisFinding[] = [
  { severity: "critical", location: "src/wallet.ts:12", text: "nil dereference" },
  { severity: "warning", location: "src/wallet.ts:40", text: "missing error context" },
  { severity: "style", location: "src/format.ts:3", text: "unclear name" },
];

test("saves and loads the last review from .git", () => {
  const dir = makeRepo();
  try {
    const path = saveLastReview(dir, {
      recipe: "review",
      model: "test-model",
      findings: FINDINGS,
    });
    assert.ok(path && path.endsWith(join("oc-pilot", "last-review.json")));

    const loaded = loadLastReview(dir);
    assert.equal(loaded?.recipe, "review");
    assert.equal(loaded?.model, "test-model");
    assert.deepEqual(loaded?.findings, FINDINGS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns undefined outside a git repository and for damaged files", () => {
  const plain = mkdtempSync(join(tmpdir(), "oc-pilot-no-repo-"));
  try {
    assert.equal(lastReviewPath(plain), undefined);
    assert.equal(saveLastReview(plain, { recipe: "review", findings: FINDINGS }), undefined);
    assert.equal(loadLastReview(plain), undefined);
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }

  const dir = makeRepo();
  try {
    const path = lastReviewPath(dir);
    assert.ok(path);
    mkdirSync(join(dir, ".git", "oc-pilot"), { recursive: true });
    writeFileSync(path, "{not json", "utf8");
    assert.equal(loadLastReview(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseTarget accepts file:line and file:line:column", () => {
  assert.deepEqual(parseTarget("src/wallet.ts:12"), { file: "src/wallet.ts", line: 12 });
  assert.deepEqual(parseTarget("src/wallet.ts:12:5"), { file: "src/wallet.ts", line: 12 });
  assert.deepEqual(parseTarget("./src/wallet.ts:3"), { file: "src/wallet.ts", line: 3 });
  assert.deepEqual(parseTarget("src\\wallet.ts:3"), { file: "src/wallet.ts", line: 3 });
  assert.equal(parseTarget("src/wallet.ts"), undefined);
  assert.equal(parseTarget("src/wallet.ts:0"), undefined);
});

test("matchFindings prefers the exact line, then neighbours, then the file", () => {
  const exact = matchFindings(FINDINGS, { file: "src/wallet.ts", line: 12 });
  assert.deepEqual(exact.map((finding) => finding.text), ["nil dereference"]);

  const near = matchFindings(FINDINGS, { file: "src/wallet.ts", line: 14 });
  assert.deepEqual(near.map((finding) => finding.location), ["src/wallet.ts:12"]);

  const fileOnly = matchFindings(FINDINGS, { file: "src/wallet.ts", line: 90 });
  assert.equal(fileOnly.length, 2);

  assert.deepEqual(matchFindings(FINDINGS, { file: "src/other.ts", line: 1 }), []);
});

test("explain prints the saved findings for a location", () => {
  const dir = makeRepo();
  try {
    saveLastReview(dir, { recipe: "review", model: "test-model", findings: FINDINGS });
    const result = spawnSync(
      "node",
      [join(process.cwd(), "dist", "cli.js"), "explain", "--cwd", dir, "src/wallet.ts:12"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /nil dereference/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
