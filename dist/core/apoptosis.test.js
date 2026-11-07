import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { applyApoptosis, renderApoptosis, scanApoptosis } from "./apoptosis.js";
function git(args, cwd, env = {}) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
    if (result.status !== 0)
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}
function makeRepo(files, date = "2020-01-01T00:00:00Z") {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-apoptosis-"));
    git(["init", "-q"], dir);
    git(["config", "user.email", "test@example.com"], dir);
    git(["config", "user.name", "Test"], dir);
    git(["config", "core.autocrlf", "false"], dir);
    for (const [path, content] of Object.entries(files)) {
        const full = join(dir, path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content, "utf8");
    }
    git(["add", "."], dir);
    git(["commit", "-m", "init"], dir, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    return dir;
}
const APP = [
    "/* @lifespan: 30d */",
    "export function oldFn() {",
    "  return 1;",
    "}",
    "",
    "/* @lifespan: 30d */",
    "export function usedFn() {",
    "  return 2;",
    "}",
    "",
].join("\n");
test("scan marks an unreferenced old function as senescent and keeps a used one alive", () => {
    const dir = makeRepo({ "src/app.ts": APP, "src/use.ts": 'import { usedFn } from "./app.js";\nconsole.log(usedFn());\n' });
    try {
        const report = scanApoptosis(dir);
        assert.equal(report.entries.length, 2);
        const old = report.entries.find((entry) => entry.symbol === "oldFn");
        const used = report.entries.find((entry) => entry.symbol === "usedFn");
        assert.equal(old?.status, "senescent");
        assert.equal(old?.references, 0);
        assert.equal(used?.status, "alive");
        assert.ok((used?.references ?? 0) > 0);
        assert.match(report.content, /\[Senescent\]/);
        assert.match(renderApoptosis(report), /Найдено сенесцентных функций: 1/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("a fresh marker stays alive even without references", () => {
    const dir = makeRepo({ "src/app.ts": APP }, "2026-11-07T00:00:00Z");
    try {
        const report = scanApoptosis(dir, { now: new Date("2026-11-07T12:00:00Z") });
        assert.equal(report.entries.find((entry) => entry.symbol === "oldFn")?.status, "alive");
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("apply refuses to run without confirmation", async () => {
    const dir = makeRepo({ "src/app.ts": APP });
    try {
        await assert.rejects(() => applyApoptosis(dir, { command: 'node -e "process.exit(0)"', confirm: false }), /--confirm/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("apply comments out a senescent function in a shadow tree and lands it when tests pass", async () => {
    const dir = makeRepo({ "src/app.ts": APP, "src/use.ts": 'import { usedFn } from "./app.js";\nconsole.log(usedFn());\n' });
    try {
        const result = await applyApoptosis(dir, { command: 'node -e "process.exit(0)"', confirm: true });
        assert.equal(result.status, "applied");
        assert.equal(result.removed.length, 1);
        const text = readFileSync(join(dir, "src", "app.ts"), "utf8");
        assert.match(text, /\/\/ \[apoptosis\] oldFn removed/);
        assert.match(text, /\/\/ export function oldFn/);
        assert.match(text, /export function usedFn/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("a failing test command leaves the working tree untouched", async () => {
    const dir = makeRepo({ "src/app.ts": APP });
    try {
        const before = readFileSync(join(dir, "src", "app.ts"), "utf8");
        const result = await applyApoptosis(dir, { command: 'node -e "process.exit(1)"', confirm: true });
        assert.equal(result.status, "tests-failed");
        assert.equal(readFileSync(join(dir, "src", "app.ts"), "utf8"), before);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=apoptosis.test.js.map