import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyMutation,
  listMutationSites,
  maskNonCode,
  renderMutation,
  runMutation,
  type MutationReport,
} from "./mutation.js";

const SOURCE = [
  "// a === b in a comment",
  'const text = "x !== y";',
  "const same = a === b;",
  "const flag = true;",
  "if (a >= b && c <= d) { return false; }",
  "",
].join("\n");

test("listMutationSites finds operators outside strings and comments", () => {
  const sites = listMutationSites("src/app.js", SOURCE);
  assert.deepEqual(
    sites.map((site) => site.operator),
    ["===", "true", ">=", "&&", "<=", "false"],
  );
  assert.equal(sites[0]?.line, 3);
  assert.equal(sites[0]?.replacement, "!==");
  assert.equal(sites[3]?.replacement, "||");
});

test("maskNonCode keeps offsets and newlines", () => {
  const masked = maskNonCode(SOURCE);
  assert.equal(masked.length, SOURCE.length);
  assert.equal(masked.split("\n").length, SOURCE.split("\n").length);
  assert.equal(masked.split("===").length - 1, 1);
  assert.equal(masked.includes("!=="), false);
});

test("applyMutation replaces only the selected site", () => {
  const source = "const a = x === y;\nconst b = x === z;\n";
  const sites = listMutationSites("src/a.js", source);
  assert.equal(sites.length, 2);
  const mutated = applyMutation(source, sites[1]!);
  assert.equal(mutated, "const a = x === y;\nconst b = x !== z;\n");
});

test("runMutation kills a covered mutant and leaves an uncovered one alive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-mutation-"));
  try {
    const source = [
      "function same(a, b) { return a === b; }",
      "const flag = true;",
      "module.exports = { same };",
      "",
    ].join("\n");
    writeFileSync(join(dir, "calc.js"), source, "utf8");
    writeFileSync(
      join(dir, "check.js"),
      ['const { same } = require("./calc.js");', "if (!same(1, 1)) process.exit(1);", ""].join("\n"),
      "utf8",
    );

    const report = await runMutation(dir, [{ path: "calc.js", text: source }], {
      command: "node check.js",
      maxMutants: 2,
    });

    assert.equal(report.sites, 2);
    assert.equal(report.mutants.length, 2);
    assert.equal(report.killed, 1);
    assert.equal(report.survived, 1);
    assert.equal(report.score, 50);
    assert.equal(report.mutants[0]?.operator, "===");
    assert.equal(report.mutants[1]?.operator, "true");
    assert.equal(readFileSync(join(dir, "calc.js"), "utf8"), source);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderMutation lists survivors and the score", () => {
  const report: MutationReport = {
    command: "node check.js",
    files: ["calc.js"],
    sites: 2,
    mutants: [
      {
        file: "calc.js",
        line: 1,
        column: 30,
        operator: "===",
        original: "===",
        replacement: "!==",
        status: "killed",
        durationMs: 10,
      },
      {
        file: "calc.js",
        line: 2,
        column: 14,
        operator: "true",
        original: "true",
        replacement: "false",
        status: "survived",
        durationMs: 12,
      },
    ],
    killed: 1,
    survived: 1,
    timedOut: 0,
    score: 50,
    truncated: false,
    durationMs: 30,
  };

  const text = renderMutation(report);
  assert.match(text, /Mutation score: 50\/100/);
  assert.match(text, /Выжившие мутации/);
  assert.match(text, /calc\.js:2 true → false/);
  assert.ok(text.endsWith("\n"));
});
