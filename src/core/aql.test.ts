import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectAqlNodes, runAql, splitAql } from "./aql.js";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-aql-"));
  const init = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "app.ts"),
    [
      'import { readFileSync } from "node:fs";',
      'export function load() { return stripe("x"); }',
      'const pay = () => stripe("y");',
      "class Client {}",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(join(dir, "src", "other.ts"), 'stripe("z");\n', "utf8");
  return dir;
}

test("collectAqlNodes builds files, functions, classes, imports and calls", () => {
  const dir = makeRepo();
  try {
    const nodes = collectAqlNodes(dir);
    assert.equal(nodes.filter((node) => node.type === "File").length, 2);
    assert.deepEqual(
      nodes.filter((node) => node.type === "Function").map((node) => node.name),
      ["load", "pay"],
    );
    assert.equal(nodes.filter((node) => node.type === "Class").length, 1);
    assert.equal(nodes.filter((node) => node.type === "Import" && node.specifier === "node:fs").length, 1);
    assert.equal(nodes.filter((node) => node.type === "CallExpression" && node.name === "stripe").length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runAql filters, selects, sorts and counts", () => {
  const dir = makeRepo();
  try {
    const calls = runAql(dir, "find(CallExpression).where(name, 'stripe').select(file, line)");
    assert.equal(calls.count, 3);
    assert.ok(calls.rows.every((row) => typeof row.file === "string" && typeof row.line === "number"));
    assert.match(calls.content, /src\/app\.ts/);

    const functions = runAql(dir, "find(Function).where(file, 'src/app.ts').select(name, line)");
    assert.deepEqual(functions.rows.map((row) => row.name), ["load", "pay"]);

    const imports = runAql(dir, "find(Import).where(specifier, 'node:fs').count()");
    assert.equal(imports.count, 1);
    assert.deepEqual(imports.rows, []);
    assert.match(imports.content, /1 node\(s\)/);

    assert.throws(() => runAql(dir, "find(CallExpression).drop(name)"), /Неизвестный шаг AQL/);
    assert.throws(() => runAql(dir, "select(file)"), /начинаться с find/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("splitAql keeps dots inside quotes in one stage", () => {
  assert.deepEqual(splitAql("find(CallExpression).where(name, 'a.b').select(file, line)"), [
    "find(CallExpression)",
    "where(name, 'a.b')",
    "select(file, line)",
  ]);
});
