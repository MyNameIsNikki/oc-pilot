import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bisectMayday, renderMaydayBisect, renderMaydayRollback, rollbackMayday, } from "./mayday.js";
function git(args, cwd) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0)
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout;
}
function makeRepo() {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-mayday-"));
    git(["init", "-q"], dir);
    git(["config", "user.email", "test@example.com"], dir);
    git(["config", "user.name", "Test"], dir);
    git(["config", "core.autocrlf", "false"], dir);
    writeFileSync(join(dir, "check.mjs"), [
        'import { readFileSync } from "node:fs";',
        'const text = readFileSync(new URL("./app.mjs", import.meta.url), "utf8");',
        "const value = Number(/value = (\\d+)/.exec(text)[1]);",
        "process.exit(value <= 2 ? 0 : 1);",
        "",
    ].join("\n"), "utf8");
    const commit = (value) => {
        writeFileSync(join(dir, "app.mjs"), `export const value = ${String(value)};\n`, "utf8");
        git(["add", "."], dir);
        git(["commit", "-m", `value ${String(value)}`], dir);
        return git(["rev-parse", "HEAD"], dir).trim();
    };
    const good = commit(1);
    commit(2);
    const bad = commit(3);
    commit(4);
    return { dir, good, bad };
}
test("bisectMayday finds the first commit where the check starts failing", async () => {
    const repo = makeRepo();
    try {
        const result = await bisectMayday(repo.dir, repo.good, "HEAD", {
            command: "node check.mjs",
            timeoutMs: 20_000,
        });
        assert.equal(result.status, "found");
        assert.equal(result.firstBad?.sha, repo.bad);
        assert.equal(result.firstBad?.subject, "value 3");
        assert.ok(result.steps.length >= 2);
        assert.match(result.summary, /\[MAYDAY FOUND\]/);
        assert.match(renderMaydayBisect(result), /First bad:/);
    }
    finally {
        rmSync(repo.dir, { recursive: true, force: true });
    }
});
test("bisectMayday rejects a bad range", async () => {
    const repo = makeRepo();
    try {
        await assert.rejects(() => bisectMayday(repo.dir, "HEAD", repo.good, { command: "node check.mjs" }), /не является предком/);
        await assert.rejects(() => bisectMayday(repo.dir, repo.good, repo.good, { command: "node check.mjs" }), /один коммит/);
    }
    finally {
        rmSync(repo.dir, { recursive: true, force: true });
    }
});
test("rollbackMayday reverts the range and creates a tested branch", async () => {
    const repo = makeRepo();
    try {
        const result = await rollbackMayday(repo.dir, repo.good, {
            testCommand: "node check.mjs",
            branch: "oc-pilot/mayday-test",
            timeoutMs: 20_000,
        });
        assert.equal(result.status, "ready", result.summary);
        assert.equal(result.reverted, 3);
        assert.equal(result.tests, "pass");
        assert.equal(result.branch, "oc-pilot/mayday-test");
        assert.equal(git(["rev-parse", "--verify", "refs/heads/oc-pilot/mayday-test"], repo.dir).trim(), git(["rev-parse", "oc-pilot/mayday-test"], repo.dir).trim());
        assert.match(git(["show", "oc-pilot/mayday-test:app.mjs"], repo.dir), /value = 1/);
        assert.match(git(["log", "--format=%s", "-1", "oc-pilot/mayday-test"], repo.dir), /mayday: rollback to/);
        assert.match(renderMaydayRollback(result), /MAYDAY ROLLBACK READY/);
    }
    finally {
        rmSync(repo.dir, { recursive: true, force: true });
    }
});
test("rollbackMayday reports a failing rollback but still exposes the branch", async () => {
    const repo = makeRepo();
    try {
        const result = await rollbackMayday(repo.dir, repo.good, {
            testCommand: 'node -e "process.exit(1)"',
            branch: "oc-pilot/mayday-failing",
            timeoutMs: 20_000,
        });
        assert.equal(result.status, "failed");
        assert.equal(result.tests, "fail");
        assert.equal(git(["rev-parse", "--verify", "refs/heads/oc-pilot/mayday-failing"], repo.dir).trim().length, 40);
        assert.match(result.summary, /\[MAYDAY ROLLBACK FAILED\]/);
    }
    finally {
        rmSync(repo.dir, { recursive: true, force: true });
    }
});
test("rollbackMayday reports nothing to revert at HEAD", async () => {
    const repo = makeRepo();
    try {
        const result = await rollbackMayday(repo.dir, "HEAD", { runTests: false });
        assert.equal(result.status, "none");
        assert.equal(result.reverted, 0);
        assert.match(result.summary, /\[MAYDAY NONE\]/);
    }
    finally {
        rmSync(repo.dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=mayday.test.js.map