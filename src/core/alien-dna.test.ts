import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { analyzeAlienDna, collectAddedLines, collectDna } from "./alien-dna.js";

function git(args: string[], cwd: string): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-alien-dna-"));
  git(["init", "-q"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  git(["config", "core.autocrlf", "false"], dir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content, "utf8");
  }
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
  return dir;
}

function diff(path: string, body: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1 +1,${String(body.length + 1)} @@`,
    " export function load() { return 1; }",
    ...body.map((line) => `+${line}`),
  ].join("\n");
}

test("collectDna counts patterns per occurrence and per file", () => {
  const stats = collectDna([
    {
      path: "src/store.ts",
      text: [
        "class Store {",
        "  private static instance: Store;",
        "  static getInstance() { return Store.instance; }",
        "}",
        "new Proxy(target, {});",
      ].join("\n"),
    },
    { path: "src/other.ts", text: "new Proxy(other, {});\n" },
    { path: "src/ignored.ts", text: '// new Proxy(x, {})\nconst text = "new Proxy(x, {})";\n' },
  ]);

  const singleton = stats.find((pattern) => pattern.id === "singleton");
  const proxy = stats.find((pattern) => pattern.id === "proxy");
  assert.equal(singleton?.count, 2);
  assert.equal(singleton?.files, 1);
  assert.equal(proxy?.count, 2);
  assert.equal(proxy?.files, 2);
});

test("collectAddedLines tracks new line numbers through context", () => {
  const added = collectAddedLines(
    [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,2 +1,4 @@",
      " const a = 1;",
      "+new Proxy(a, {});",
      " const b = 2;",
      "+class Store { private static instance: Store; }",
    ].join("\n"),
  );

  assert.deepEqual(added, [
    { path: "src/app.ts", line: 2, text: "new Proxy(a, {});" },
    { path: "src/app.ts", line: 4, text: "class Store { private static instance: Store; }" },
  ]);
});

test("analyzeAlienDna blocks a pattern that never appeared in HEAD", () => {
  const dir = makeRepo({ "src/app.ts": "export function load() { return 1; }\n" });
  try {
    const report = analyzeAlienDna(
      dir,
      diff("src/app.ts", ["new Proxy({}, {});", "class Store { private static instance: Store; }"]),
    );
    assert.equal(report.baseline, "HEAD");
    assert.deepEqual(
      report.triggers.map((trigger) => trigger.id),
      ["singleton", "proxy"],
    );
    assert.match(report.summary, /^\[ALIEN DNA DETECTED\]: The agent used a Singleton class\./);
    assert.match(report.content, /src\/app\.ts:3 singleton/);
    assert.equal(report.patterns.find((pattern) => pattern.id === "singleton")?.count, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("analyzeAlienDna accepts a pattern that already exists in HEAD", () => {
  const dir = makeRepo({
    "src/app.ts": "export function load() { return 1; }\nexport const state = new Proxy({}, {});\n",
  });
  try {
    const report = analyzeAlienDna(dir, diff("src/app.ts", ["export const another = new Proxy({}, {});"]));
    assert.equal(report.triggers.length, 0);
    assert.equal(report.patterns.find((pattern) => pattern.id === "proxy")?.count, 1);
    assert.equal(report.summary, "Архитектурная ДНК совпадает: чужих паттернов нет.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("analyzeAlienDna ignores generated and non-code paths", () => {
  const dir = makeRepo({ "src/app.ts": "export function load() { return 1; }\n" });
  try {
    const report = analyzeAlienDna(
      dir,
      [
        diff("dist/bundle.js", ["new Proxy({}, {});"]),
        diff("README.md", ["new Proxy({}, {});"]),
      ].join("\n"),
    );
    assert.equal(report.triggers.length, 0);
    assert.equal(report.addedLines, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
