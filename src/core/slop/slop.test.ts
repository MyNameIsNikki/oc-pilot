import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeChurn } from "./churn.js";
import { findDeadExports } from "./dead-exports.js";
import { findDuplicates } from "./duplicates.js";
import type { CommitFiles, SourceFile } from "./model.js";
import { buildReport, compareSlop, describeSlop, gradeOf, badgeSvg } from "./score.js";
import { findTodos } from "./todos.js";

const BLOCK = [
  "function computeInvoiceTotal(items, taxRate, discountRate) {",
  "  let subtotal = 0;",
  "  for (const item of items) {",
  "    subtotal += item.price * item.quantity;",
  "  }",
  "  const taxed = subtotal * (1 + taxRate);",
  "  const discounted = taxed * (1 - discountRate);",
  "  return Math.round(discounted * 100) / 100;",
  "}",
].join("\n");

function source(path: string, text: string): SourceFile {
  return { path, text };
}

test("findDuplicates spots the same block in two files", () => {
  const files = [
    source("src/billing.ts", `${BLOCK}\nconst localA = 1;\n`),
    source("src/invoice.ts", `${BLOCK}\nconst localB = 2;\n`),
  ];
  const pairs = findDuplicates(files);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]?.first.file, "src/billing.ts");
  assert.equal(pairs[0]?.second.file, "src/invoice.ts");
  assert.ok((pairs[0]?.tokens ?? 0) >= 18);
});

test("findDuplicates ignores comments and single-file repetition", () => {
  const comment = "// shared explanation ".repeat(20);
  const files = [
    source("src/a.ts", `${comment}\nconst alpha = 1;\nconst beta = 2;\nconst gamma = 3;\n`),
    source("src/b.ts", `${comment}\nconst delta = 4;\nconst epsilon = 5;\nconst zeta = 6;\n`),
    source("src/c.ts", `${BLOCK}\n${BLOCK}\n`),
  ];
  assert.deepEqual(findDuplicates(files), []);
});

test("findDeadExports reports only exports nobody imports", () => {
  const files = [
    source("src/a.ts", "export function usedEverywhere() {\n  return 1;\n}\n\nexport function neverUsed() {\n  return 2;\n}\n"),
    source("src/b.ts", 'import { usedEverywhere } from "./a.js";\n\nusedEverywhere();\n'),
  ];
  const dead = findDeadExports(files);
  assert.deepEqual(
    dead.map((item) => item.name),
    ["neverUsed"],
  );
  assert.equal(dead[0]?.file, "src/a.ts");
  assert.equal(dead[0]?.line, 5);
});

test("findDeadExports skips entry points and tests", () => {
  const files = [
    source("src/index.ts", "export const entryOnly = 1;\n"),
    source("src/a.ts", "export const helperUsedInTests = 1;\n"),
    source("src/a.test.ts", 'import { helperUsedInTests } from "./a.js";\n'),
  ];
  assert.deepEqual(findDeadExports(files), []);
});

test("analyzeChurn flags hot files without tests", () => {
  const commits: CommitFiles[] = Array.from({ length: 6 }, (_, index) => ({
    sha: `sha${String(index)}`,
    timestamp: index * 86_400_000,
    files: ["src/wallet.ts"],
  }));
  const churn = analyzeChurn(commits);
  assert.equal(churn.length, 1);
  assert.equal(churn[0]?.file, "src/wallet.ts");
  assert.equal(churn[0]?.commits, 6);
  assert.equal(churn[0]?.testCommits, 0);
  assert.equal(churn[0]?.days, 5);
});

test("analyzeChurn ignores files whose commits touch tests", () => {
  const commits: CommitFiles[] = Array.from({ length: 6 }, (_, index) => ({
    sha: `sha${String(index)}`,
    timestamp: index * 86_400_000,
    files: ["src/wallet.ts", "src/wallet.test.ts"],
  }));
  assert.deepEqual(analyzeChurn(commits), []);
});

test("analyzeChurn requires the minimum number of commits", () => {
  const commits: CommitFiles[] = Array.from({ length: 3 }, (_, index) => ({
    sha: `sha${String(index)}`,
    timestamp: index * 86_400_000,
    files: ["src/wallet.ts"],
  }));
  assert.deepEqual(analyzeChurn(commits), []);
});

test("findTodos collects markers with age and skips tests", () => {
  const files = [
    source("src/a.ts", "// TODO: remove the fallback\nconst a = 1;\n// FIXME(alice): race condition\n"),
    source("src/a.test.ts", "// TODO: fixture marker\n"),
  ];
  const todos = findTodos(files, {
    lineAge: (file, line) => (file === "src/a.ts" && line === 1 ? 120 : 5),
  });
  assert.equal(todos.length, 2);
  assert.equal(todos[0]?.line, 1);
  assert.equal(todos[0]?.ageDays, 120);
  assert.match(todos[0]?.text ?? "", /TODO: remove the fallback/);
  assert.equal(todos[1]?.text, "FIXME(alice): race condition");
});

test("buildReport sums categories and grades the index", () => {
  const report = buildReport({
    duplicates: [{ first: { file: "a.ts", line: 1 }, second: { file: "b.ts", line: 1 }, tokens: 40 }],
    deadExports: [
      { file: "a.ts", line: 3, name: "x", kind: "function" },
      { file: "a.ts", line: 9, name: "y", kind: "function" },
    ],
    churn: [{ file: "a.ts", commits: 7, days: 9, testCommits: 0 }],
    todos: [{ file: "a.ts", line: 4, text: "TODO: later", ageDays: 200 }],
    stats: { filesScanned: 2, linesScanned: 20, truncated: false },
  });

  assert.equal(report.categories.length, 4);
  assert.equal(report.index, report.categories.reduce((sum, category) => sum + category.score, 0));
  assert.ok(report.index > 0 && report.index <= 100);
  assert.equal(report.grade, gradeOf(report.index));
  assert.match(describeSlop(report), /Slop Index/);
  assert.match(describeSlop(report), /Мёртвый код/);

  assert.equal(gradeOf(0), "чисто");
  assert.equal(gradeOf(30), "умеренно");
  assert.equal(gradeOf(60), "гниёт");
  assert.equal(gradeOf(90), "критично");
});

test("compareSlop counts introduced and removed findings", () => {
  const empty = buildReport({
    duplicates: [],
    deadExports: [],
    churn: [],
    todos: [],
    stats: { filesScanned: 1, linesScanned: 1, truncated: false },
  });
  const current = buildReport({
    duplicates: [],
    deadExports: [{ file: "src/a.ts", line: 3, name: "leftover", kind: "function" }],
    churn: [],
    todos: [{ file: "src/a.ts", line: 7, text: "TODO: later", ageDays: 100 }],
    stats: { filesScanned: 1, linesScanned: 10, truncated: false },
  });

  const delta = compareSlop(empty, current, "main");
  assert.equal(delta.base, "main");
  assert.equal(delta.introduced, 2);
  assert.equal(delta.removed, 0);
  assert.equal(delta.deltaPoints, 2.1);
  const duplicateDelta = delta.categories.find((category) => category.id === "duplicates");
  assert.equal(duplicateDelta?.introduced, 0);
});

test("badgeSvg renders the index", () => {
  const report = buildReport({
    duplicates: [],
    deadExports: [],
    churn: [],
    todos: [],
    stats: { filesScanned: 1, linesScanned: 1, truncated: false },
  });
  const svg = badgeSvg(report);
  assert.match(svg, /<svg/);
  assert.match(svg, /slop: 0\/100/);
});
