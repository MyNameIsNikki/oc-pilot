import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  deployHoneypot,
  detectHoneypotTriggers,
  honeypotStatus,
  readHoneypotManifest,
  removeHoneypot,
  renderHoneypotStatus,
} from "./honeypot.js";

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "oc-pilot-honeypot-"));
}

test("deploy writes decoys, manifest and status", () => {
  const dir = makeDir();
  try {
    const result = deployHoneypot(dir);
    assert.equal(result.created.length, 3);
    assert.equal(result.skipped.length, 0);
    assert.equal(result.manifest, join(".oc-pilot", "honeypot.json"));
    for (const path of [".env.backup", "src/utils/legacy/bypassAuth.ts", "src/legacy/legacy_db_drop.ts"]) {
      assert.equal(existsSync(join(dir, path)), true, path);
    }
    const status = honeypotStatus(dir);
    assert.equal(status.deployed, true);
    assert.equal(status.entries.length, 3);
    assert.equal(status.triggers.length, 0);
    assert.match(renderHoneypotStatus(status), /\.env\.backup/);
    assert.ok(readHoneypotManifest(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deploy skips existing files unless force", () => {
  const dir = makeDir();
  try {
    writeFileSync(join(dir, ".env.backup"), "real\n", "utf8");
    const first = deployHoneypot(dir);
    assert.equal(first.created.length, 2);
    assert.deepEqual(first.skipped, [".env.backup"]);
    assert.equal(readFileSync(join(dir, ".env.backup"), "utf8"), "real\n");

    const second = deployHoneypot(dir, { force: true });
    assert.equal(second.created.length, 3);
    assert.match(readFileSync(join(dir, ".env.backup"), "utf8"), /oc-pilot honeypot/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectHoneypotTriggers returns null without a manifest", () => {
  const dir = makeDir();
  try {
    assert.equal(detectHoneypotTriggers(dir, "", []), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectHoneypotTriggers flags imports, reads and changed decoys", () => {
  const dir = makeDir();
  try {
    deployHoneypot(dir);
    const diff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -0,0 +1,3 @@",
      '+import { bypassAuth } from "./utils/legacy/bypassAuth";',
      '+const key = "AKIAIOSFODNN7EXAMPLE";',
      "+export const allowed = bypassAuth(null);",
      "diff --git a/src/utils/legacy/bypassAuth.ts b/src/utils/legacy/bypassAuth.ts",
      "--- a/src/utils/legacy/bypassAuth.ts",
      "+++ b/src/utils/legacy/bypassAuth.ts",
      "@@ -1 +1 @@",
      "-export const bypassAuth = (_user: unknown): boolean => true;",
      "+export const bypassAuth = (_user: unknown): boolean => true; // touched",
      "",
    ].join("\n");
    const scan = detectHoneypotTriggers(dir, diff, ["src/app.ts", "src/utils/legacy/bypassAuth.ts"]);
    assert.ok(scan);
    assert.equal(scan.deployed, true);
    assert.ok(scan.triggers.length >= 2);
    assert.ok(scan.triggers.some((trigger) => trigger.symbol === "bypassAuth"));
    assert.ok(scan.triggers.some((trigger) => trigger.kind === "env"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("remove deletes only marker files and the manifest", () => {
  const dir = makeDir();
  try {
    deployHoneypot(dir);
    writeFileSync(join(dir, ".env.backup"), "real\n", "utf8");
    const result = removeHoneypot(dir);
    assert.deepEqual(result.removed.sort(), [
      "src/legacy/legacy_db_drop.ts",
      "src/utils/legacy/bypassAuth.ts",
    ]);
    assert.deepEqual(result.missing, [".env.backup"]);
    assert.equal(existsSync(join(dir, ".env.backup")), true);
    assert.equal(existsSync(join(dir, "src/utils/legacy/bypassAuth.ts")), false);
    assert.equal(readHoneypotManifest(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
