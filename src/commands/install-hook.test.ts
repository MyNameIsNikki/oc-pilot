import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runGit } from "../core/git.js";
import {
  HOOK_MARKER,
  hookScript,
  installHook,
  resolveHooksDir,
  uninstallHook,
} from "./install-hook.js";

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-hook-"));
  runGit(["init"], dir);
  return dir;
}

test("installHook writes a managed pre-commit hook", () => {
  const dir = initRepo();
  try {
    const result = installHook(dir, "pre-commit", false);
    assert.ok(existsSync(result.path));
    const script = readFileSync(result.path, "utf8");
    assert.ok(script.includes(HOOK_MARKER));
    assert.ok(script.includes("oc-pilot preflight --staged"));
    assert.ok(script.includes("OC_PILOT_SKIP"));
    assert.ok(!script.includes("\r"), "hook script must use LF endings");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hookScript prefers OC_PILOT_BIN and the project-local binary", () => {
  const script = hookScript("pre-commit");
  assert.ok(script.includes('if [ -n "$OC_PILOT_BIN" ]'));
  assert.ok(script.includes("./node_modules/.bin/oc-pilot"));
  assert.ok(
    script.indexOf("./node_modules/.bin/oc-pilot") < script.indexOf("command -v oc-pilot"),
    "local binary must be checked before the global PATH",
  );
  assert.ok(script.includes("OC_PILOT_BIN or install oc-pilot"));
});

test("hookScript can fall back to scan-only pre-commit", () => {
  const script = hookScript("pre-commit", "scan");
  assert.ok(script.includes("oc-pilot scan --staged"));
  assert.ok(!script.includes("preflight"));
});

test("hookScript pre-commit runs preflight by default", () => {
  const script = hookScript("pre-commit");
  assert.ok(script.includes("oc-pilot preflight --staged"));
  assert.ok(!script.includes("scan --staged"));
});

test("hookScript pre-push runs review", () => {
  const script = hookScript("pre-push");
  assert.ok(script.includes("oc-pilot review --fail-on critical --fail-on-secrets"));
  assert.ok(script.includes(HOOK_MARKER));
});

test("installHook refuses foreign hooks without force and backs up with force", () => {
  const dir = initRepo();
  try {
    const hooks = resolveHooksDir(dir);
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\necho mine\n", "utf8");

    assert.throws(() => installHook(dir, "pre-commit", false), /не принадлежит oc-pilot/);

    installHook(dir, "pre-commit", true);
    const backup = join(hooks, "pre-commit.oc-pilot.bak");
    assert.ok(existsSync(backup));
    assert.ok(readFileSync(backup, "utf8").includes("echo mine"));
    assert.ok(readFileSync(join(hooks, "pre-commit"), "utf8").includes(HOOK_MARKER));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uninstallHook removes ours and restores the backup", () => {
  const dir = initRepo();
  try {
    const hooks = resolveHooksDir(dir);
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\necho mine\n", "utf8");
    installHook(dir, "pre-commit", true);

    const result = uninstallHook(dir, "pre-commit");
    assert.ok(result.backup);
    assert.ok(readFileSync(join(hooks, "pre-commit"), "utf8").includes("echo mine"));
    assert.ok(!existsSync(join(hooks, "pre-commit.oc-pilot.bak")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uninstallHook refuses foreign hooks and tolerates missing hooks", () => {
  const dir = initRepo();
  try {
    const hooks = resolveHooksDir(dir);
    const result = uninstallHook(dir, "pre-push");
    assert.equal(result.removed, false);

    writeFileSync(join(hooks, "pre-push"), "#!/bin/sh\necho mine\n", "utf8");
    assert.throws(() => uninstallHook(dir, "pre-push"), /не принадлежит oc-pilot/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reinstall over our own hook is allowed without force", () => {
  const dir = initRepo();
  try {
    installHook(dir, "pre-commit", false);
    installHook(dir, "pre-commit", false);
    const hooks = resolveHooksDir(dir);
    assert.ok(readFileSync(join(hooks, "pre-commit"), "utf8").includes(HOOK_MARKER));
    assert.ok(!existsSync(join(hooks, "pre-commit.oc-pilot.bak")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
