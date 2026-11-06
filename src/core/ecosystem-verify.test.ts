import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ecosystemIssueFailsGate,
  hasExport,
  namedImports,
  verifyEcosystem,
} from "./ecosystem-verify.js";

function makeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-ecosystem-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return dir;
}

test("namedImports reads named and aliased imports with line numbers", () => {
  const source = [
    'import { leftPad, trim as trimText } from "left-pad";',
    'export { helper } from "helpers";',
  ].join("\n");
  const uses = namedImports(source, "src/app.ts");
  assert.equal(uses.length, 2);
  assert.deepEqual(uses[0]?.names, ["leftPad", "trim"]);
  assert.equal(uses[0]?.source, "left-pad");
  assert.equal(uses[0]?.line, 1);
  assert.deepEqual(uses[1]?.names, ["helper"]);
  assert.equal(uses[1]?.line, 2);
});

test("hasExport understands declarations, export lists and wildcards", () => {
  assert.equal(hasExport("export function leftPad() {}", "leftPad").found, true);
  assert.equal(hasExport("export { leftPad }", "leftPad").found, true);
  assert.equal(hasExport("exports.leftPad = () => {}", "leftPad").found, true);
  assert.equal(hasExport("export * from './internal';", "anything").wildcard, true);
  assert.equal(hasExport("module.exports = api;", "anything").wildcard, true);
  assert.equal(hasExport("export function other() {}", "leftPad").found, false);
});

test("verifyEcosystem flags an invented export in an installed package", async () => {
  const dir = makeProject({
    "package.json": JSON.stringify({ name: "demo", dependencies: { "left-pad": "^1.3.0" } }),
    "node_modules/left-pad/package.json": JSON.stringify({ name: "left-pad", version: "1.3.0", main: "index.js", types: "index.d.ts" }),
    "node_modules/left-pad/index.d.ts": "export function leftPad(text: string, width: number): string;\nexport const VERSION: string;\n",
    "src/app.ts": 'import { leftPad, invented } from "left-pad";\n\nleftPad("x", 3);\ninvented();\n',
  });
  try {
    const diff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,1 +1,4 @@",
      '+import { leftPad, invented } from "left-pad";',
      "+",
      '+leftPad("x", 3);',
      "+invented();",
    ].join("\n");
    const report = await verifyEcosystem(dir, diff, ["src/app.ts"]);
    assert.equal(report.status, "fail");
    assert.equal(report.packages[0]?.name, "left-pad");
    assert.equal(report.packages[0]?.installed, true);
    assert.deepEqual(report.packages[0]?.missingExports, ["invented"]);
    const issue = report.issues.find((item) => item.kind === "missing-export");
    assert.ok(issue);
    assert.equal(issue.package, "left-pad");
    assert.match(issue.detail, /invented/);
    assert.equal(issue.file, "src/app.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyEcosystem flags a package that is neither installed nor declared", async () => {
  const dir = makeProject({
    "package.json": JSON.stringify({ name: "demo", dependencies: {} }),
    "src/app.ts": 'import { magic } from "ghost-package";\nmagic();\n',
  });
  try {
    const diff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,1 +1,2 @@",
      '+import { magic } from "ghost-package";',
      "+magic();",
    ].join("\n");
    const report = await verifyEcosystem(dir, diff, ["src/app.ts"]);
    assert.equal(report.status, "fail");
    assert.equal(report.packages[0]?.name, "ghost-package");
    assert.equal(report.packages[0]?.installed, false);
    assert.equal(report.packages[0]?.declared, false);
    assert.ok(report.issues.some((item) => item.kind === "missing-package" && item.severity === "high"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyEcosystem trusts a wildcard export", async () => {
  const dir = makeProject({
    "package.json": JSON.stringify({ name: "demo", dependencies: { "left-pad": "^1.3.0" } }),
    "node_modules/left-pad/package.json": JSON.stringify({ name: "left-pad", version: "1.3.0", types: "index.d.ts" }),
    "node_modules/left-pad/index.d.ts": "export * from './internal';\n",
    "src/app.ts": 'import { anything } from "left-pad";\n',
  });
  try {
    const diff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,1 +1,1 @@",
      '+import { anything } from "left-pad";',
    ].join("\n");
    const report = await verifyEcosystem(dir, diff, ["src/app.ts"]);
    assert.equal(report.status, "pass");
    assert.equal(report.issues.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyEcosystem checks new packages online for age and downloads", async () => {
  const dir = makeProject({
    "package.json": JSON.stringify({ name: "demo", dependencies: {} }),
  });
  try {
    const diff = [
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -1,3 +1,4 @@",
      " {",
      '   "name": "demo",',
      '   "dependencies": {',
      '+    "brand-new-lib": "^1.0.0"',
      "   }",
      " }",
    ].join("\n");
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      const payload = url.includes("downloads")
        ? { downloads: 5 }
        : { time: { created: new Date().toISOString() } };
      return { ok: true, json: async () => payload } as Response;
    }) as typeof fetch;
    const report = await verifyEcosystem(dir, diff, [], {
      online: true,
      minAgeDays: 30,
      minDownloads: 1000,
      fetchImpl,
    });
    assert.equal(report.status, "fail");
    assert.ok(report.issues.some((item) => item.kind === "new-package" && item.severity === "high"));
    assert.ok(report.issues.some((item) => item.kind === "low-downloads" && item.severity === "medium"));
    assert.equal(ecosystemIssueFailsGate(report.issues, "high"), true);
    assert.equal(ecosystemIssueFailsGate([], "high"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
