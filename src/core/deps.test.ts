import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeDependencyChanges, describeDependencyFindings } from "./deps.js";

const NPM_DIFF = `diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -10,4 +10,9 @@
   "dependencies": {
+    "axios": "^1.7.0",
+    "lodahs": "^4.17.21",
+    "left-pad": "git+https://github.com/user/left-pad.git",
+    "tiny-lib": "*",
+    "sneaky": "latest",
+  },
`;

test("flags npm dependency additions with risks", () => {
  const findings = analyzeDependencyChanges(NPM_DIFF);
  const names = findings.map((finding) => finding.name);
  assert.ok(names.includes("axios"));
  assert.ok(names.includes("lodahs"));
  assert.ok(names.includes("left-pad"));

  const lodahs = findings.find((finding) => finding.name === "lodahs");
  assert.ok(lodahs);
  assert.ok(lodahs.risks.some((risk) => risk.includes("typosquat of lodash")), lodahs.risks.join(","));

  const leftPad = findings.find((finding) => finding.name === "left-pad");
  assert.ok(leftPad);
  assert.ok(leftPad.risks.includes("vcs-or-url reference"));

  const tinyLib = findings.find((finding) => finding.name === "tiny-lib");
  assert.ok(tinyLib);
  assert.ok(tinyLib.risks.includes("unpinned"));

  const sneaky = findings.find((finding) => finding.name === "sneaky");
  assert.ok(sneaky);
  assert.ok(sneaky.risks.includes("unpinned"));

  assert.equal(lodahs.ecosystem, "npm");
  assert.equal(lodahs.file, "package.json");
});

test("parses go.mod, Gemfile and requirements.txt additions", () => {
  const diff = `diff --git a/go.mod b/go.mod
+++ b/go.mod
@@ -3,2 +3,3 @@
 module example.com/app
+github.com/user/repo v1.2.3
diff --git a/Gemfile b/Gemfile
+++ b/Gemfile
@@ -1,2 +1,3 @@
 source "https://rubygems.org"
+gem "rails", "~> 7.0"
diff --git a/requirements.txt b/requirements.txt
+++ b/requirements.txt
@@ -1 +1,2 @@
 requests==2.31.0
+django==4.2
`;
  const findings = analyzeDependencyChanges(diff);
  const go = findings.find((finding) => finding.ecosystem === "go");
  assert.ok(go);
  assert.equal(go.name, "github.com/user/repo");
  assert.equal(go.spec, "v1.2.3");

  const gem = findings.find((finding) => finding.ecosystem === "rubygems");
  assert.ok(gem);
  assert.equal(gem.name, "rails");

  const pypi = findings.find((finding) => finding.ecosystem === "pypi");
  assert.ok(pypi);
  assert.equal(pypi.name, "django");
});

test("ignores lockfiles and non-manifest diffs", () => {
  const lockDiff = `diff --git a/package-lock.json b/package-lock.json
+++ b/package-lock.json
@@ -1,2 +1,3 @@
+    "lodash": "4.17.21",
`;
  assert.deepEqual(analyzeDependencyChanges(lockDiff), []);

  const codeDiff = `diff --git a/src/index.ts b/src/index.ts
+++ b/src/index.ts
@@ -1 +1,2 @@
+const x: Record<string, string> = {};
`;
  assert.deepEqual(analyzeDependencyChanges(codeDiff), []);
});

test("describeDependencyFindings renders one line per finding", () => {
  const findings = analyzeDependencyChanges(NPM_DIFF);
  const text = describeDependencyFindings(findings);
  for (const line of text.split("\n")) {
    assert.ok(line.startsWith("- "), line);
  }
  assert.ok(text.includes("npm: lodahs"));
});
