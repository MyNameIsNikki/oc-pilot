import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mannWhitney, median, percentile, runHemorrhage, summarize, } from "./hemorrhage.js";
function git(args, cwd) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0)
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout;
}
function makeRepo(after = 80) {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-hemorrhage-"));
    git(["init", "-q"], dir);
    git(["config", "user.email", "test@example.com"], dir);
    git(["config", "user.name", "Test"], dir);
    git(["config", "core.autocrlf", "false"], dir);
    writeFileSync(join(dir, "app.mjs"), "export const value = 0;\n", "utf8");
    writeFileSync(join(dir, "notes.txt"), "one\n", "utf8");
    writeFileSync(join(dir, "bench.mjs"), [
        'import { readFileSync } from "node:fs";',
        'const text = readFileSync(new URL("./app.mjs", import.meta.url), "utf8");',
        "const value = Number(/value = (\\d+)/.exec(text)[1]);",
        "const end = Date.now() + value;",
        "while (Date.now() < end) {}",
        "console.log(value);",
        "",
    ].join("\n"), "utf8");
    git(["add", "."], dir);
    git(["commit", "-m", "init"], dir);
    const diff = [
        "diff --git a/app.mjs b/app.mjs",
        "--- a/app.mjs",
        "+++ b/app.mjs",
        "@@ -1,1 +1,1 @@",
        "-export const value = 0;",
        `+export const value = ${String(after)};`,
        "",
    ].join("\n");
    return { dir, diff };
}
test("median, percentile, summarize and mannWhitney are deterministic", () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
    assert.ok(percentile([1, 2, 3, 4], 0.95) > 3.5);
    const stats = summarize([10, 10, 10]);
    assert.equal(stats.median, 10);
    assert.equal(stats.p95, 10);
    assert.equal(stats.mad, 0);
    assert.ok(mannWhitney([1, 2, 3, 4, 5], [10, 11, 12, 13, 14]) < 0.05);
    assert.ok(mannWhitney([1, 2, 3], [1, 2, 3]) > 0.99);
});
test("runHemorrhage detects a regression with a stdout metric", async () => {
    const repo = makeRepo(400);
    try {
        const report = await runHemorrhage(repo.dir, repo.diff, {
            command: "node bench.mjs",
            metric: "stdout",
            runs: 5,
            warmup: 0,
            thresholdPct: 20,
            timeoutMs: 30_000,
        });
        assert.equal(report.status, "regression", report.summary);
        assert.ok(report.changePct > 20);
        assert.ok(report.pValue < 0.05);
        assert.equal(report.before.median, 0);
        assert.equal(report.after.median, 400);
        assert.match(report.summary, /\[PERFORMANCE REGRESSION\]/);
        assert.match(report.content, /Before: median/);
    }
    finally {
        rmSync(repo.dir, { recursive: true, force: true });
    }
});
test("runHemorrhage reports the same performance for an unrelated diff", async () => {
    const repo = makeRepo();
    try {
        const diff = [
            "diff --git a/notes.txt b/notes.txt",
            "--- a/notes.txt",
            "+++ b/notes.txt",
            "@@ -1,1 +1,1 @@",
            "-one",
            "+two",
            "",
        ].join("\n");
        const report = await runHemorrhage(repo.dir, diff, {
            command: "node bench.mjs",
            runs: 5,
            warmup: 1,
            thresholdPct: 20,
            timeoutMs: 20_000,
        });
        assert.equal(report.status, "same", report.summary);
        assert.match(report.summary, /\[PERFORMANCE SAME\]/);
    }
    finally {
        rmSync(repo.dir, { recursive: true, force: true });
    }
});
test("runHemorrhage collects time samples for both trees", async () => {
    const repo = makeRepo(80);
    try {
        const report = await runHemorrhage(repo.dir, repo.diff, {
            command: "node bench.mjs",
            metric: "time",
            runs: 3,
            warmup: 0,
            thresholdPct: 20,
            timeoutMs: 20_000,
        });
        assert.equal(report.metric, "time");
        assert.equal(report.before.runs, 3);
        assert.equal(report.after.runs, 3);
        assert.ok(["regression", "improvement", "same"].includes(report.status));
    }
    finally {
        rmSync(repo.dir, { recursive: true, force: true });
    }
});
test("runHemorrhage rejects a failing benchmark", async () => {
    const repo = makeRepo();
    try {
        await assert.rejects(() => runHemorrhage(repo.dir, repo.diff, {
            command: 'node -e "process.exit(1)"',
            runs: 3,
            warmup: 0,
        }), /Бенчмарк завершился/);
    }
    finally {
        rmSync(repo.dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=hemorrhage.test.js.map