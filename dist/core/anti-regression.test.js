import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { addedLines, analyzeAntiRegression, deletedLines, describeAntiRegression } from "./anti-regression.js";
function git(args, cwd) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result.stdout;
}
function makeRepo() {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-anti-regression-"));
    git(["init", "-q"], dir);
    git(["config", "user.email", "test@example.com"], dir);
    git(["config", "user.name", "Test"], dir);
    git(["config", "core.autocrlf", "false"], dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    return dir;
}
function commit(dir, message) {
    git(["add", "."], dir);
    git(["commit", "-m", message], dir);
    return git(["rev-parse", "HEAD"], dir).trim();
}
test("addedLines collects only added code lines with new line numbers", () => {
    const diff = [
        "diff --git a/src/wallet.ts b/src/wallet.ts",
        "--- a/src/wallet.ts",
        "+++ b/src/wallet.ts",
        "@@ -1,2 +1,3 @@",
        " export function charge(amount: number) {",
        "+  return amount * 2;",
        " }",
        "diff --git a/src/wallet.test.ts b/src/wallet.test.ts",
        "--- a/src/wallet.test.ts",
        "+++ b/src/wallet.test.ts",
        "@@ -1,1 +1,2 @@",
        "+it(\"charges twice\", () => {});",
    ].join("\n");
    const lines = addedLines(diff);
    assert.deepEqual(lines.map((line) => `${line.file}:${String(line.line)}:${line.text}`), ["src/wallet.ts:2:return amount * 2;"]);
});
test("analyzeAntiRegression cites the commit that deleted the line", () => {
    const dir = makeRepo();
    try {
        writeFileSync(join(dir, "src", "wallet.ts"), "export function charge(amount: number) {\n  return amount * 2;\n}\n", "utf8");
        commit(dir, "add wallet");
        writeFileSync(join(dir, "src", "wallet.ts"), "export function charge(amount: number) {\n  return 0;\n}\n", "utf8");
        const removed = commit(dir, "stop doubling the charge");
        const diff = [
            "diff --git a/src/wallet.ts b/src/wallet.ts",
            "--- a/src/wallet.ts",
            "+++ b/src/wallet.ts",
            "@@ -1,3 +1,3 @@",
            " export function charge(amount: number) {",
            "+  return amount * 2;",
            " }",
            "",
        ].join("\n");
        const report = analyzeAntiRegression(dir, diff);
        assert.equal(report.status, "fail");
        assert.equal(report.findings.length, 1);
        const finding = report.findings[0];
        assert.equal(finding.file, "src/wallet.ts");
        assert.equal(finding.line, 2);
        assert.equal(finding.kind, "readded-line");
        assert.equal(finding.commit.hash, removed);
        assert.match(finding.commit.subject, /stop doubling/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("analyzeAntiRegression flags a re-added import", () => {
    const dir = makeRepo();
    try {
        writeFileSync(join(dir, "src", "config.ts"), 'import { readFileSync } from "node:fs";\n\nexport const config = readFileSync("config.json", "utf8");\n', "utf8");
        commit(dir, "load config from disk");
        writeFileSync(join(dir, "src", "config.ts"), "export const config = {};\n", "utf8");
        commit(dir, "drop filesystem config");
        const diff = [
            "diff --git a/src/config.ts b/src/config.ts",
            "--- a/src/config.ts",
            "+++ b/src/config.ts",
            "@@ -1,1 +1,2 @@",
            '+import { readFileSync } from "node:fs";',
            " export const config = {};",
            "",
        ].join("\n");
        const report = analyzeAntiRegression(dir, diff);
        assert.equal(report.findings.length, 1);
        assert.equal(report.findings[0]?.kind, "readded-import");
        assert.equal(report.findings[0]?.severity, "high");
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("analyzeAntiRegression ignores lines that were never deleted", () => {
    const dir = makeRepo();
    try {
        writeFileSync(join(dir, "src", "app.ts"), "export const version = 1;\n", "utf8");
        commit(dir, "initial");
        const diff = [
            "diff --git a/src/app.ts b/src/app.ts",
            "--- a/src/app.ts",
            "+++ b/src/app.ts",
            "@@ -1,1 +1,2 @@",
            " export const version = 1;",
            "+export const feature = \"new\";",
            "",
        ].join("\n");
        const report = analyzeAntiRegression(dir, diff);
        assert.equal(report.status, "pass");
        assert.equal(report.findings.length, 0);
        assert.equal(report.checkedLines, 1);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("deletedLines and describeAntiRegression summarize the history", () => {
    const dir = makeRepo();
    try {
        writeFileSync(join(dir, "src", "app.ts"), "export function oldThing() {\n  return 42;\n}\n", "utf8");
        commit(dir, "add old thing");
        writeFileSync(join(dir, "src", "app.ts"), "export function newThing() {\n  return 1;\n}\n", "utf8");
        const removed = commit(dir, "remove old thing");
        const deleted = deletedLines(dir, "src/app.ts");
        assert.ok(deleted.has("export function oldThing() {"));
        assert.equal(deleted.get("export function oldThing() {")?.hash, removed);
        assert.equal(deleted.has("return 42;"), false);
        const report = analyzeAntiRegression(dir, [
            "diff --git a/src/app.ts b/src/app.ts",
            "--- a/src/app.ts",
            "+++ b/src/app.ts",
            "@@ -1,1 +1,2 @@",
            "+export function oldThing() {",
            "+  return 42;",
            "",
        ].join("\n"));
        const text = describeAntiRegression(report.findings);
        assert.match(text, /src\/app\.ts:1/);
        assert.match(text, /remove old thing/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=anti-regression.test.js.map