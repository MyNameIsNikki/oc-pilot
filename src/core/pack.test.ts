import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildPack, extractSignatures, extractTestNames } from "./pack.js";

const DIFF = [
  "diff --git a/src/wallet.ts b/src/wallet.ts",
  "--- a/src/wallet.ts",
  "+++ b/src/wallet.ts",
  "@@ -1,3 +1,3 @@",
  "-export function charge(amount: number) {",
  "+export function chargeCard(amount: number) {",
  "   return amount;",
  " }",
  "",
].join("\n");

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-pack-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return dir;
}

test("extractSignatures keeps declarations and drops bodies", () => {
  const source = [
    'import { Money } from "./money";',
    "",
    "export interface User {",
    "  id: string;",
    "}",
    "",
    "export function charge(amount: number) {",
    "  return amount;",
    "}",
    "",
    "export class Wallet {",
    "  balance = 0;",
    "",
    "  deposit(amount: number) {",
    "    return amount;",
    "  }",
    "}",
    "",
  ].join("\n");

  const signatures = extractSignatures(source).join("\n");
  assert.match(signatures, /import \{ Money \} from "\.\/money"/);
  assert.match(signatures, /export interface User/);
  assert.match(signatures, /export function charge\(amount: number\)/);
  assert.match(signatures, /export class Wallet/);
  assert.match(signatures, /deposit\(amount: number\)/);
  assert.doesNotMatch(signatures, /return amount/);
});

test("extractTestNames reads it, test and describe names", () => {
  const source = [
    'describe("wallet", () => {',
    '  it("charges the card", () => {});',
    '  test("refunds a payment", () => {});',
    "});",
  ].join("\n");

  assert.deepEqual(extractTestNames(source), ["wallet", "charges the card", "refunds a payment"]);
});

test("buildPack includes the task, rules, signatures, references and test log", () => {
  const dir = makeRepo({
    "src/wallet.ts": 'export function chargeCard(amount: number) {\n  return amount;\n}\n',
    "src/checkout.ts": 'import { charge } from "./wallet";\n\nexport function pay() {\n  return charge(10);\n}\n',
    ".oc-pilot/rules.md": "Use the smallest safe change.\n",
  });
  try {
    const report = buildPack(dir, {
      task: "Rename charge to chargeCard",
      diff: DIFF,
      changedFiles: ["src/wallet.ts"],
      testLog: "AssertionError: expected 10 to equal 20",
    });

    assert.match(report.content, /# Context pack/);
    assert.match(report.content, /Rename charge to chargeCard/);
    assert.match(report.content, /Правила проекта/);
    assert.match(report.content, /Use the smallest safe change/);
    assert.match(report.content, /Изменённые файлы/);
    assert.match(report.content, /src\/wallet\.ts/);
    assert.match(report.content, /export function chargeCard/);
    assert.match(report.content, /Связанные файлы/);
    assert.match(report.content, /src\/checkout\.ts/);
    assert.match(report.content, /Последнее падение тестов/);
    assert.match(report.content, /AssertionError/);
    assert.equal(report.truncated, false);
    assert.ok(report.files.some((file) => file.file === "src/wallet.ts" && file.role === "changed"));
    assert.ok(report.files.some((file) => file.file === "src/checkout.ts" && file.role === "related"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildPack respects the character budget", () => {
  const dir = makeRepo({
    "src/wallet.ts": [
      "export function charge(amount: number) {",
      "  return amount;",
      "}",
      "export function refund(amount: number) {",
      "  return amount;",
      "}",
      "export function transfer(from: string, to: string, amount: number) {",
      "  return { from, to, amount };",
      "}",
      "",
    ].join("\n"),
  });
  try {
    const report = buildPack(dir, {
      task: "Review the wallet",
      diff: DIFF,
      changedFiles: ["src/wallet.ts"],
      budget: 300,
      testLog: "x".repeat(5000),
    });

    assert.equal(report.truncated, true);
    assert.ok(report.chars <= 300, `chars ${String(report.chars)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
