import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeImpact, describeImpact, extractChangedSymbols } from "./impact.js";
const DIFF = [
    "diff --git a/src/wallet.ts b/src/wallet.ts",
    "--- a/src/wallet.ts",
    "+++ b/src/wallet.ts",
    "@@ -1,3 +1,6 @@",
    "-export function charge(amount: number) {",
    "+export function chargeCard(amount: number) {",
    "   return amount;",
    " }",
    "+",
    "+export function refund(amount: number) {",
    "+  return amount;",
    "+}",
].join("\n");
function git(args, cwd) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result.stdout;
}
function makeRepo() {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-impact-"));
    git(["init"], dir);
    git(["config", "user.email", "test@example.com"], dir);
    git(["config", "user.name", "Test"], dir);
    git(["config", "core.autocrlf", "false"], dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "wallet.ts"), "export function charge(amount: number) {\n  return amount;\n}\n");
    writeFileSync(join(dir, "src", "checkout.ts"), 'import { charge } from "./wallet";\n\nexport function pay() {\n  return charge(10);\n}\n');
    writeFileSync(join(dir, "README.md"), "# demo\n");
    git(["add", "."], dir);
    git(["commit", "-m", "init"], dir);
    return dir;
}
test("extractChangedSymbols reports added and removed declarations", () => {
    const symbols = extractChangedSymbols(DIFF);
    const byName = new Map(symbols.map((symbol) => [symbol.name, symbol]));
    assert.ok(byName.has("charge"), "removed declaration is tracked");
    assert.ok(byName.has("chargeCard"), "added declaration is tracked");
    assert.equal(byName.get("refund")?.kind, "function");
    assert.equal(byName.get("refund")?.file, "src/wallet.ts");
    assert.equal(byName.get("refund")?.line, 5);
});
test("extractChangedSymbols filters generic names", () => {
    const diff = [
        "+++ b/src/app.ts",
        "@@ -1,1 +1,3 @@",
        "+function run() {",
        "+const data = () => 1;",
        "+export function collectInvoices() {",
    ].join("\n");
    const symbols = extractChangedSymbols(diff);
    assert.deepEqual(symbols.map((symbol) => symbol.name), ["collectInvoices"]);
});
test("analyzeImpact finds call sites outside the changed files", () => {
    const dir = makeRepo();
    try {
        const report = analyzeImpact(dir, DIFF, ["src/wallet.ts"]);
        const chargeUses = report.references.filter((reference) => reference.symbol === "charge");
        // A textual search also reports the import line; that is expected noise.
        assert.deepEqual(chargeUses.map((reference) => `${reference.file}:${reference.line}`), ["src/checkout.ts:1", "src/checkout.ts:4"]);
        assert.ok(report.references.every((reference) => reference.file !== "src/wallet.ts"));
        assert.ok(report.scannedFiles > 0);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("analyzeImpact also scans untracked files", () => {
    const dir = makeRepo();
    try {
        writeFileSync(join(dir, "src", "extra.ts"), "export const total = refund(3);\n");
        const report = analyzeImpact(dir, DIFF, ["src/wallet.ts"]);
        const refundUses = report.references.filter((reference) => reference.symbol === "refund");
        assert.deepEqual(refundUses.map((reference) => reference.file), ["src/extra.ts"]);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("describeImpact renders symbols with and without usages", () => {
    const report = {
        symbols: [
            { name: "refund", kind: "function", file: "src/wallet.ts", line: 5 },
            { name: "Ledger", kind: "type", file: "src/ledger.ts", line: 1 },
        ],
        references: [{ symbol: "refund", file: "src/api.ts", line: 9, text: "await refund(5);" }],
        scannedFiles: 3,
        touchedFiles: ["src/wallet.ts"],
    };
    const text = describeImpact(report);
    assert.match(text, /refund \(function\) — src\/wallet\.ts:5/);
    assert.match(text, /src\/api\.ts:9 {2}await refund\(5\);/);
    assert.match(text, /Ledger \(type\) — src\/ledger\.ts:1/);
    assert.equal(describeImpact({ ...report, symbols: [] }), "Изменённых объявлений не найдено.");
});
//# sourceMappingURL=impact.test.js.map