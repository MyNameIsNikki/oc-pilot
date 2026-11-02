import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearStats, countApiCallsSince, readStats, recordApiCall, recordRun, summarizeStats, todayStartMs } from "./stats.js";
function makeRepo() {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-stats-"));
    const git = (...args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    git("init");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("config", "core.autocrlf", "false");
    return dir;
}
function statsPath(cwd) {
    const raw = spawnSync("git", ["-C", cwd, "rev-parse", "--git-dir"], { encoding: "utf8" }).stdout.trim();
    return join(resolve(cwd, raw), "oc-pilot", "stats.jsonl");
}
test("records api calls and runs, reads them back", () => {
    const dir = makeRepo();
    try {
        recordApiCall(dir, { model: "m1", cached: false, durationMs: 100 });
        recordApiCall(dir, { model: "m1", cached: true, durationMs: 0 });
        recordRun(dir, { recipe: "review", engine: "openai", exitCode: 3, findings: { critical: 1, warning: 2, style: 0 } });
        const records = readStats(dir);
        assert.equal(countApiCallsSince(records, 0), 1);
        const summary = summarizeStats(records, 0);
        assert.equal(summary.runs, 1);
        assert.equal(summary.apiCalls, 2);
        assert.equal(summary.cacheHits, 1);
        assert.equal(summary.findings.critical, 1);
        assert.equal(summary.findings.warning, 2);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("countApiCallsSince respects the since cutoff", () => {
    const dir = makeRepo();
    try {
        recordApiCall(dir, { model: "m1", cached: false, durationMs: 50 });
        const records = readStats(dir);
        assert.equal(countApiCallsSince(records, 0), 1);
        assert.equal(countApiCallsSince(records, Date.now() + 60_000), 0);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("corrupt lines are skipped when reading", () => {
    const dir = makeRepo();
    try {
        recordApiCall(dir, { model: "m1", cached: false, durationMs: 50 });
        appendFileSync(statsPath(dir), "not json at all\n");
        const records = readStats(dir);
        assert.equal(countApiCallsSince(records, 0), 1);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("clearStats wipes the log", () => {
    const dir = makeRepo();
    try {
        recordApiCall(dir, { model: "m1", cached: false, durationMs: 50 });
        recordRun(dir, { recipe: "review", engine: "openai", exitCode: 0, findings: { critical: 0, warning: 0, style: 0 } });
        assert.equal(clearStats(dir), true);
        const summary = summarizeStats(readStats(dir), 0);
        assert.equal(summary.runs, 0);
        assert.equal(summary.apiCalls, 0);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("todayStartMs is midnight local time", () => {
    const now = new Date(2026, 0, 15, 13, 45);
    const start = todayStartMs(now.getTime());
    const startDate = new Date(start);
    assert.equal(startDate.getHours(), 0);
    assert.equal(startDate.getMinutes(), 0);
    assert.equal(startDate.getDate(), 15);
});
//# sourceMappingURL=stats.test.js.map