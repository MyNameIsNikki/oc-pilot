import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildCinema, describeCinema } from "./cinema.js";
function git(args, cwd) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result.stdout;
}
function makeRepo() {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cinema-"));
    git(["init", "-q"], dir);
    git(["config", "user.email", "test@example.com"], dir);
    git(["config", "user.name", "Test"], dir);
    git(["config", "core.autocrlf", "false"], dir);
    writeFileSync(join(dir, "app.ts"), "export const value = 1;\n", "utf8");
    git(["add", "."], dir);
    git(["commit", "-m", "add the first value"], dir);
    return dir;
}
test("buildCinema renders a self-contained HTML player", () => {
    const dir = makeRepo();
    try {
        const report = buildCinema(dir, { title: "session", sinceDays: 30 });
        assert.equal(report.format, "html");
        assert.ok(report.frames.length >= 1);
        assert.match(report.content, /<!doctype html>/i);
        assert.match(report.content, /<title>session<\/title>/);
        assert.match(report.content, /play/i);
        assert.ok(report.content.includes("add the first value"));
        assert.ok(!/<script src=/.test(report.content));
        assert.ok(!/<link[^>]+href=/.test(report.content));
        assert.match(describeCinema(report), /кадров за 30 дн\. \(HTML\)/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("buildCinema emits an asciinema cast and hides paths", () => {
    const dir = makeRepo();
    try {
        const report = buildCinema(dir, { sinceDays: 30, noPaths: true, cast: true });
        assert.equal(report.format, "cast");
        assert.match(report.content, /"version":2/);
        assert.match(report.content, /"o"/);
        assert.ok(!report.content.includes("add the first value"));
        assert.ok(report.content.includes("(path hidden)"));
        assert.match(describeCinema(report), /asciinema cast/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("buildCinema keeps only the newest frames", () => {
    const dir = makeRepo();
    try {
        writeFileSync(join(dir, "app.ts"), "export const value = 2;\n", "utf8");
        git(["add", "."], dir);
        git(["commit", "-m", "bump the value"], dir);
        const report = buildCinema(dir, { sinceDays: 30, maxFrames: 1 });
        assert.equal(report.frames.length, 1);
        assert.ok(report.frames[0]?.text.includes("bump the value"));
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=cinema.test.js.map