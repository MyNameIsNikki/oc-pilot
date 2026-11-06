import assert from "node:assert/strict";
import test from "node:test";
import {
  addedImports,
  analyzeBoundaries,
  globToRegExp,
  matchesBoundary,
  parseBoundaryConfig,
  resolveImport,
} from "./boundaries.js";

const DIFF = [
  "diff --git a/src/ui/app.ts b/src/ui/app.ts",
  "--- a/src/ui/app.ts",
  "+++ b/src/ui/app.ts",
  "@@ -1,1 +1,5 @@",
  ' import { Button } from "@/components/button";',
  '+import { db } from "../db/user";',
  '+import type { User } from "../db/types";',
  '+import React from "react";',
  '+const legacy = require("../db/legacy");',
  "",
].join("\n");

test("globToRegExp and matchesBoundary cover the glob subset", () => {
  assert.ok(globToRegExp("src/ui/**").test("src/ui/app.ts"));
  assert.ok(globToRegExp("src/**/test.ts").test("src/a/b/test.ts"));
  assert.ok(globToRegExp("src/**/test.ts").test("src/test.ts"));
  assert.ok(!globToRegExp("src/ui/**").test("src/lib/app.ts"));
  assert.ok(matchesBoundary("src/ui/**", "src/ui/app.ts"));
  assert.ok(matchesBoundary("react", "react/jsx-runtime"));
  assert.ok(!matchesBoundary("react", "react-dom"));
});

test("resolveImport maps aliases and relative paths", () => {
  assert.equal(resolveImport("src/ui/app.ts", "@/db/user"), "src/db/user");
  assert.equal(resolveImport("src/ui/app.ts", "../db/user"), "src/db/user");
  assert.equal(resolveImport("src/ui/app.ts", "react"), "react");
});

test("parseBoundaryConfig validates rules and keeps reasons", () => {
  const config = parseBoundaryConfig(
    JSON.stringify({
      rules: [{ from: "src/ui/**", deny: ["src/db/**"], reason: "UI не ходит в БД" }],
    }),
    ".oc-pilot/architecture.json",
  );
  assert.equal(config.rules.length, 1);
  assert.equal(config.rules[0]?.reason, "UI не ходит в БД");
  assert.throws(() => parseBoundaryConfig("{}", "architecture.json"), /нет правил/);
  assert.throws(
    () => parseBoundaryConfig(JSON.stringify({ rules: [{ from: "src/ui/**" }] }), "architecture.json"),
    /без списка deny/,
  );
});

test("addedImports reads added imports and skips type-only imports", () => {
  const imports = addedImports(DIFF);
  assert.deepEqual(
    imports.map((use) => `${use.file}:${String(use.line)}:${use.specifier}`),
    ["src/ui/app.ts:2:../db/user", "src/ui/app.ts:4:react", "src/ui/app.ts:5:../db/legacy"],
  );
});

test("analyzeBoundaries reports denied imports and passes allowed ones", () => {
  const config = parseBoundaryConfig(
    JSON.stringify({
      rules: [{ from: "src/ui/**", deny: ["src/db/**"], reason: "UI не ходит в БД" }],
    }),
    ".oc-pilot/architecture.json",
  );
  const report = analyzeBoundaries(DIFF, config);
  assert.equal(report.status, "fail");
  assert.equal(report.scannedFiles, 1);
  assert.deepEqual(
    report.violations.map((violation) => `${violation.file}:${String(violation.line)}:${violation.resolved}`),
    ["src/ui/app.ts:2:src/db/user", "src/ui/app.ts:5:src/db/legacy"],
  );

  const allowed = analyzeBoundaries(DIFF, parseBoundaryConfig(
    JSON.stringify({ rules: [{ from: "src/ui/**", deny: ["src/services/**"] }] }),
    "architecture.json",
  ));
  assert.equal(allowed.status, "pass");
  assert.equal(allowed.violations.length, 0);
});

test("analyzeBoundaries matches a denied package by its raw specifier", () => {
  const config = parseBoundaryConfig(
    JSON.stringify({ rules: [{ from: "src/ui/**", deny: ["react"] }] }),
    "architecture.json",
  );
  const report = analyzeBoundaries(DIFF, config);
  assert.equal(report.violations.length, 1);
  assert.equal(report.violations[0]?.imported, "react");
  assert.equal(report.violations[0]?.resolved, "react");
});
