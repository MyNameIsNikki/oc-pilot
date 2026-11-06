import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeAutopsy, renderAutopsy } from "./autopsy.js";
function git(args, cwd) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result.stdout;
}
function makeRepo() {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-autopsy-"));
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
test("analyzeAutopsy finds a dangerous command injection", () => {
    const dir = makeRepo();
    try {
        writeFileSync(join(dir, "src", "app.js"), 'const { exec } = require("child_process");\nexec(req.query.cmd);\n', "utf8");
        const hash = commit(dir, "add the debug command");
        const report = analyzeAutopsy(dir, "HEAD");
        assert.equal(report.commit.hash, hash);
        assert.equal(report.verdict, "dangerous");
        assert.ok(report.signals.some((signal) => signal.kind === "sast" && signal.file === "src/app.js"));
        assert.equal(report.suspects[0]?.file, "src/app.js");
        assert.match(report.summary, /high/);
        assert.match(renderAutopsy(report), /ВСКРЫТИЕ КОММИТА/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("analyzeAutopsy flags a weakened test", () => {
    const dir = makeRepo();
    try {
        writeFileSync(join(dir, "src", "app.ts"), "export const value = 1;\n", "utf8");
        commit(dir, "add the value");
        writeFileSync(join(dir, "src", "app.test.ts"), 'import { value } from "./app";\n\nit.skip("returns one", () => {\n  expect(value).toBe(1);\n});\n', "utf8");
        commit(dir, "skip the failing test");
        const report = analyzeAutopsy(dir, "HEAD");
        assert.ok(report.signals.some((signal) => signal.kind === "test-weakening"));
        assert.equal(report.verdict, "dangerous");
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("analyzeAutopsy reports a clean commit", () => {
    const dir = makeRepo();
    try {
        writeFileSync(join(dir, "src", "value.ts"), "export const value = 1;\n", "utf8");
        commit(dir, "add a value");
        const report = analyzeAutopsy(dir, "HEAD");
        assert.equal(report.verdict, "clean");
        assert.deepEqual(report.signals, []);
        assert.deepEqual(report.suspects, []);
        assert.match(report.summary, /не оставил рискованных сигналов/i);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("analyzeAutopsy builds a before and after timeline", () => {
    const dir = makeRepo();
    try {
        writeFileSync(join(dir, "src", "app.ts"), "export const value = 1;\n", "utf8");
        commit(dir, "add the value");
        writeFileSync(join(dir, "src", "app.ts"), "export const value = 2;\n", "utf8");
        const target = commit(dir, "bump the value");
        writeFileSync(join(dir, "src", "app.ts"), "export const value = 3;\n", "utf8");
        commit(dir, "bump it again");
        const report = analyzeAutopsy(dir, "HEAD~1", { depth: 5 });
        assert.equal(report.commit.hash, target);
        assert.ok(report.timeline.some((entry) => entry.relation === "target" && entry.commit.hash === target));
        assert.ok(report.timeline.some((entry) => entry.relation === "after"));
        assert.ok(report.timeline.some((entry) => entry.relation === "before"));
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("analyzeAutopsy rejects an unknown revision", () => {
    const dir = makeRepo();
    try {
        writeFileSync(join(dir, "src", "app.ts"), "export const value = 1;\n", "utf8");
        commit(dir, "add the value");
        assert.throws(() => analyzeAutopsy(dir, "does-not-exist"), /does-not-exist|ревизи/i);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=autopsy.test.js.map