import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { describeTestPlan, selectTests } from "./test-plan.js";

const DIFF = [
  "diff --git a/src/wallet.ts b/src/wallet.ts",
  "--- a/src/wallet.ts",
  "+++ b/src/wallet.ts",
  "@@ -1,3 +1,4 @@",
  " export function charge(amount: number) {",
  "-  return amount;",
  "+  return amount * 2;",
  "+  // doubled",
  " }",
  "",
].join("\n");

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-test-plan-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return dir;
}

const FILES = {
  "src/wallet.ts": "export function charge(amount: number) {\n  return amount * 2;\n}\n",
  "src/checkout.ts": 'import { charge } from "./wallet";\n\nexport function pay() {\n  return charge(10);\n}\n',
  "src/checkout.test.ts": 'import { pay } from "./checkout";\n\ntest("pays", () => {\n  pay();\n});\n',
  "src/wallet.test.ts": 'import { charge } from "./wallet";\n\ntest("charges", () => {\n  charge(1);\n});\n',
  "src/legacy.ts": "export function legacy() {\n  return 1;\n}\n",
};

test("selectTests picks naming and transitive tests for a changed file", () => {
  const dir = makeRepo(FILES);
  try {
    const report = selectTests(dir, DIFF, ["src/wallet.ts"]);
    const byFile = new Map(report.tests.map((item) => [item.file, item]));
    assert.ok(byFile.has("src/wallet.test.ts"), "naming test missing");
    assert.ok(byFile.has("src/checkout.test.ts"), "transitive test missing");
    assert.ok(byFile.get("src/wallet.test.ts")?.reasons.includes("naming"));
    assert.ok(byFile.get("src/checkout.test.ts")?.reasons.includes("transitive-import"));
    assert.deepEqual(report.uncovered, []);
    assert.match(describeTestPlan(report), /Стратегия: affected/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("selectTests reports changed code without any test", () => {
  const dir = makeRepo(FILES);
  try {
    const report = selectTests(dir, DIFF, ["src/legacy.ts"]);
    assert.deepEqual(report.tests, []);
    assert.deepEqual(report.uncovered, ["src/legacy.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fast keeps only high-confidence tests and maxTests truncates", () => {
  const dir = makeRepo(FILES);
  try {
    const fast = selectTests(dir, DIFF, ["src/wallet.ts"], { strategy: "fast" });
    assert.deepEqual(
      fast.tests.map((item) => item.file),
      ["src/wallet.test.ts"],
    );
    const limited = selectTests(dir, DIFF, ["src/wallet.ts"], { maxTests: 1 });
    assert.equal(limited.tests.length, 1);
    assert.equal(limited.stats.totalSelected, 2);
    assert.equal(limited.stats.truncated, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("full returns every test file and printCommand substitutes {files}", () => {
  const dir = makeRepo(FILES);
  try {
    const report = selectTests(dir, DIFF, ["src/wallet.ts"], {
      strategy: "full",
      printCommand: true,
      command: "node --test {files}",
    });
    assert.equal(report.tests.length, 2);
    assert.match(report.command ?? "", /node --test .*src\/checkout\.test\.ts/);
    assert.match(report.command ?? "", /src\/wallet\.test\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
