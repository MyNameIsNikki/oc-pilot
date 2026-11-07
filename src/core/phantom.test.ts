import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderSandbox, runSandbox } from "./phantom.js";

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-phantom-test-"));
  const init = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, path), content, "utf8");
  return dir;
}

test("runSandbox executes a self-contained script and captures console", () => {
  const dir = makeRepo({ "ok.mjs": 'console.log("hello");\nconsole.log(2 + 2);\n' });
  try {
    const result = runSandbox(dir, "ok.mjs");
    assert.equal(result.status, "ok");
    assert.deepEqual(result.output, ["hello", "4"]);
    assert.match(renderSandbox(result), /Sandbox: ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSandbox blocks static imports and require", () => {
  const dir = makeRepo({
    "blocked.mjs": 'import fs from "node:fs";\nconsole.log(fs);\n',
    "blocked.cjs": 'const fs = require("node:fs");\nconsole.log(fs);\n',
  });
  try {
    const esm = runSandbox(dir, "blocked.mjs");
    assert.equal(esm.status, "blocked");
    assert.match(esm.error ?? "", /import blocked/);
    const cjs = runSandbox(dir, "blocked.cjs");
    assert.equal(cjs.status, "blocked");
    assert.match(cjs.error ?? "", /require\(node:fs\) blocked/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSandbox reports errors and kills infinite loops", () => {
  const dir = makeRepo({ "throw.mjs": 'throw new Error("boom");\n', "loop.mjs": "while (true) {}\n" });
  try {
    const thrown = runSandbox(dir, "throw.mjs");
    assert.equal(thrown.status, "error");
    assert.match(thrown.error ?? "", /boom/);
    const loop = runSandbox(dir, "loop.mjs", { timeoutMs: 300 });
    assert.equal(loop.status, "timeout");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
