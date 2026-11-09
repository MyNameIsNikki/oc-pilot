import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  clearPassport,
  createPassport,
  parsePassportCheck,
  passportPath,
  readPassport,
  renderPassport,
  renderPassportMarkdown,
  verifyPassport,
} from "./passport.js";

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-passport-"));
  git(["init", "-q"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  git(["config", "core.autocrlf", "false"], dir);
  writeFileSync(join(dir, "app.ts"), "export const value = 1;\n", "utf8");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
  return dir;
}

test("parsePassportCheck accepts name=status and rejects malformed checks", () => {
  assert.deepEqual(parsePassportCheck("tests=pass"), { name: "tests", status: "pass" });
  assert.deepEqual(parsePassportCheck("unit tests=warn"), { name: "unit tests", status: "warn" });
  assert.throws(() => parsePassportCheck("tests"), /Некорректная проверка/);
  assert.throws(() => parsePassportCheck("tests=maybe"), /Некорректная проверка/);
});

test("createPassport hashes worktree files and verify reports them valid", () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "app.ts"), "export const value = 2;\n", "utf8");
    writeFileSync(join(dir, "new.ts"), "export const added = true;\n", "utf8");

    const manifest = createPassport(dir, {
      mode: "worktree",
      agent: "claude-code",
      model: "opus-4",
      checks: [{ name: "tests", status: "pass" }],
      includeUntracked: true,
    });
    assert.equal(manifest.mode, "worktree");
    assert.equal(manifest.dirty, true);
    assert.equal(manifest.verdict, "pass");
    assert.match(manifest.digest, /^sha256:/);
    assert.ok(manifest.files.some((file) => file.path === "app.ts" && file.hash.startsWith("sha256:")));
    assert.ok(manifest.files.some((file) => file.path === "new.ts"));

    const stored = readPassport(dir);
    assert.equal(stored?.digest, manifest.digest);

    const verified = verifyPassport(dir);
    assert.equal(verified.status, "valid", verified.summary);
    assert.match(verified.summary, /\[PASSPORT VALID\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyPassport marks a changed worktree stale", () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "app.ts"), "export const value = 2;\n", "utf8");
    createPassport(dir, { mode: "worktree", checks: [{ name: "tests", status: "pass" }] });

    writeFileSync(join(dir, "app.ts"), "export const value = 3;\n", "utf8");
    const result = verifyPassport(dir);
    assert.equal(result.status, "stale");
    assert.ok(result.changed.includes("app.ts"));
    assert.match(result.summary, /\[PASSPORT STALE\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyPassport detects a tampered manifest", () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "app.ts"), "export const value = 2;\n", "utf8");
    createPassport(dir, { mode: "worktree", agent: "claude-code", checks: [{ name: "tests", status: "pass" }] });

    const manifest = JSON.parse(readFileSync(passportPath(dir), "utf8")) as Record<string, unknown>;
    manifest.agent = "someone-else";
    writeFileSync(passportPath(dir), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const result = verifyPassport(dir);
    assert.equal(result.status, "tampered");
    assert.match(result.summary, /\[PASSPORT TAMPERED\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commit passports stay valid after HEAD moves", () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "app.ts"), "export const value = 2;\n", "utf8");
    git(["add", "."], dir);
    git(["commit", "-m", "change"], dir);

    const manifest = createPassport(dir, {
      mode: "commit",
      ref: "HEAD",
      checks: [{ name: "preflight", status: "pass" }],
    });
    assert.equal(manifest.mode, "commit");
    assert.equal(manifest.dirty, false);
    assert.ok(manifest.files.some((file) => file.path === "app.ts" && file.hash.startsWith("git:")));
    assert.equal(verifyPassport(dir).status, "valid");

    writeFileSync(join(dir, "app.ts"), "export const value = 3;\n", "utf8");
    git(["add", "."], dir);
    git(["commit", "-m", "move on"], dir);

    const later = verifyPassport(dir);
    assert.equal(later.status, "valid", later.summary);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verdict requires checks and reflects warn and fail", () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "app.ts"), "export const value = 2;\n", "utf8");
    const none = createPassport(dir, { mode: "worktree" });
    assert.equal(none.verdict, "warn");

    const warn = createPassport(dir, {
      mode: "worktree",
      checks: [{ name: "tests", status: "pass" }, { name: "coverage", status: "warn" }],
    });
    assert.equal(warn.verdict, "warn");

    const fail = createPassport(dir, {
      mode: "worktree",
      checks: [{ name: "tests", status: "pass" }, { name: "sast", status: "fail" }],
    });
    assert.equal(fail.verdict, "fail");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderPassport and renderPassportMarkdown show identity and checks", () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "app.ts"), "export const value = 2;\n", "utf8");
    const manifest = createPassport(dir, {
      mode: "worktree",
      agent: "claude-code",
      model: "opus-4",
      checks: [{ name: "tests", status: "pass" }],
    });
    const text = renderPassport(manifest);
    assert.match(text, /Passport: pass/);
    assert.match(text, /Agent: claude-code/);
    assert.match(text, /tests=pass/);

    const markdown = renderPassportMarkdown(manifest);
    assert.match(markdown, /## oc-pilot passport/);
    assert.match(markdown, /claude-code/);
    assert.match(markdown, /tests/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyPassport reports a missing manifest and clearPassport removes it", () => {
  const dir = makeRepo();
  try {
    assert.equal(verifyPassport(dir).status, "missing");
    writeFileSync(join(dir, "app.ts"), "export const value = 2;\n", "utf8");
    createPassport(dir, { mode: "worktree", checks: [{ name: "tests", status: "pass" }] });
    assert.equal(clearPassport(dir).removed, true);
    assert.equal(clearPassport(dir).removed, false);
    assert.equal(verifyPassport(dir).status, "missing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
