import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AuthzFinding } from "./authz.js";
import {
  BASELINE_VERSION,
  authzFingerprint,
  loadFindingsBaseline,
  sastFingerprint,
  saveFindingsBaseline,
} from "./findings-baseline.js";
import type { SastFinding } from "./sast.js";

const SAST: SastFinding = {
  rule: "command-injection",
  severity: "high",
  file: "src/app.ts",
  line: 4,
  column: 3,
  message: "user input reaches exec",
  snippet: "exec(req.query.cmd)",
};

const AUTHZ: AuthzFinding = {
  rule: "idor",
  severity: "high",
  file: "src/routes.ts",
  line: 2,
  column: 3,
  method: "GET",
  route: "/users/:id",
  message: "object by id without an owner check",
};

function makeRepo(): string {
  return mkdtempSync(join(tmpdir(), "oc-pilot-baseline-"));
}

test("fingerprints survive line moves and distinguish targets", () => {
  assert.equal(sastFingerprint(SAST), sastFingerprint({ ...SAST, line: 40, column: 9 }));
  assert.notEqual(sastFingerprint(SAST), sastFingerprint({ ...SAST, rule: "sql-injection" }));
  assert.notEqual(sastFingerprint(SAST), sastFingerprint({ ...SAST, file: "src/other.ts" }));
  assert.equal(authzFingerprint(AUTHZ), authzFingerprint({ ...AUTHZ, line: 30 }));
  assert.notEqual(authzFingerprint(AUTHZ), authzFingerprint({ ...AUTHZ, route: "/orders/:id" }));
});

test("loadFindingsBaseline treats a missing file as empty", () => {
  const dir = makeRepo();
  try {
    const loaded = loadFindingsBaseline(dir);
    assert.equal(loaded.exists, false);
    assert.equal(loaded.baseline.version, BASELINE_VERSION);
    assert.deepEqual(loaded.baseline.sast, []);
    assert.deepEqual(loaded.baseline.authz, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveFindingsBaseline sorts and deduplicates entries", () => {
  const dir = makeRepo();
  try {
    const path = saveFindingsBaseline(dir, "base.json", {
      version: BASELINE_VERSION,
      sast: ["b", "a", "a"],
      authz: ["z", "y", "z"],
    });
    assert.match(path, /base\.json$/);
    const loaded = loadFindingsBaseline(dir, "base.json");
    assert.equal(loaded.exists, true);
    assert.deepEqual(loaded.baseline.sast, ["a", "b"]);
    assert.deepEqual(loaded.baseline.authz, ["y", "z"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadFindingsBaseline rejects broken JSON", () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "baseline.json"), "{not json", "utf8");
    assert.throws(() => loadFindingsBaseline(dir, "baseline.json"), /baseline/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
