import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyMitosis, buildMitosisPlan, renderMitosisPlan, renderMitosisPlanMarkdown, } from "./mitosis.js";
const PLAN_DIFF = [
    "diff --git a/package.json b/package.json",
    "--- a/package.json",
    "+++ b/package.json",
    "@@ -1,1 +1,2 @@",
    " {",
    '+  "zod": "^3.23.8",',
    "diff --git a/src/core/a.ts b/src/core/a.ts",
    "--- a/src/core/a.ts",
    "+++ b/src/core/a.ts",
    "@@ -1,1 +1,2 @@",
    " export const a = 1;",
    "+export const aa = 2;",
    "diff --git a/src/core/b.ts b/src/core/b.ts",
    "--- a/src/core/b.ts",
    "+++ b/src/core/b.ts",
    "@@ -1,1 +1,2 @@",
    " export const b = 1;",
    "+export const bb = 2;",
    "diff --git a/src/core/a.test.ts b/src/core/a.test.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/core/a.test.ts",
    "@@ -0,0 +1,1 @@",
    '+test("a", () => {});',
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1,1 +1,2 @@",
    " # Title",
    "+More docs.",
    "",
].join("\n");
function git(args, cwd) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0)
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout;
}
function makeRepo() {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-mitosis-"));
    git(["init", "-q"], dir);
    git(["config", "user.email", "test@example.com"], dir);
    git(["config", "user.name", "Test"], dir);
    git(["config", "core.autocrlf", "false"], dir);
    writeFileSync(join(dir, "a.txt"), "one\n", "utf8");
    writeFileSync(join(dir, "b.txt"), "one\n", "utf8");
    git(["add", "."], dir);
    git(["commit", "-m", "init"], dir);
    writeFileSync(join(dir, "a.txt"), "two\n", "utf8");
    writeFileSync(join(dir, "b.txt"), "two\n", "utf8");
    return { dir, diff: git(["diff"], dir) };
}
test("buildMitosisPlan groups by directory with config and docs apart", () => {
    const plan = buildMitosisPlan(PLAN_DIFF, { strategy: "dir" });
    assert.equal(plan.files, 5);
    assert.equal(plan.commits.length, 3);
    assert.deepEqual(plan.commits.map((commit) => commit.files), [["package.json"], ["README.md"], ["src/core/a.test.ts", "src/core/a.ts", "src/core/b.ts"]]);
    assert.match(plan.commits[2]?.title ?? "", /src\/core/);
    assert.equal(plan.additions, 5);
    assert.equal(plan.deletions, 0);
});
test("buildMitosisPlan supports file and type strategies and max-files chunks", () => {
    const byFile = buildMitosisPlan(PLAN_DIFF, { strategy: "file" });
    assert.equal(byFile.commits.length, 5);
    assert.ok(byFile.commits.every((commit) => commit.files.length === 1));
    const byType = buildMitosisPlan(PLAN_DIFF, { strategy: "type" });
    assert.deepEqual(byType.commits.map((commit) => commit.files), [["package.json"], ["src/core/a.ts", "src/core/b.ts"], ["src/core/a.test.ts"], ["README.md"]]);
    const chunked = buildMitosisPlan(PLAN_DIFF, { strategy: "dir", maxFiles: 2 });
    const core = chunked.commits.filter((commit) => commit.files.some((file) => file.startsWith("src/core")));
    assert.equal(core.length, 2);
    assert.match(core[0]?.title ?? "", /\[1\/2\]/);
    assert.match(core[1]?.title ?? "", /\[2\/2\]/);
});
test("renderMitosisPlan and renderMitosisPlanMarkdown show commits and files", () => {
    const plan = buildMitosisPlan(PLAN_DIFF, { strategy: "type" });
    const text = renderMitosisPlan(plan);
    assert.match(text, /Mitosis plan: 4 commit/);
    assert.match(text, /package\.json/);
    assert.match(text, /README\.md/);
    const markdown = renderMitosisPlanMarkdown(plan);
    assert.match(markdown, /## oc-pilot mitosis plan/);
    assert.match(markdown, /`src\/core\/a\.ts`/);
});
test("applyMitosis creates a branch with one commit per file and patch files", async () => {
    const repo = makeRepo();
    try {
        const result = await applyMitosis(repo.dir, repo.diff, {
            strategy: "file",
            branch: "oc-pilot/mitosis-test",
            runTests: false,
        });
        assert.equal(result.status, "applied", result.summary);
        assert.equal(result.commits.length, 2);
        assert.match(result.summary, /\[MITOSIS APPLIED\]/);
        const branch = git(["rev-parse", "--verify", "refs/heads/oc-pilot/mitosis-test"], repo.dir).trim();
        assert.equal(branch, result.commits[1]?.sha);
        const subjects = git(["log", "--format=%s", "-2", "oc-pilot/mitosis-test"], repo.dir).trim().split(/\r?\n/);
        assert.deepEqual(subjects, ["mitosis: update b.txt", "mitosis: update a.txt"]);
        assert.ok(result.commits.every((commit) => existsSync(commit.patchFile)));
        assert.ok(existsSync(join(repo.dir, ".oc-pilot", "mitosis")));
    }
    finally {
        rmSync(repo.dir, { recursive: true, force: true });
    }
});
test("applyMitosis stops on a failing test and still exposes the branch", async () => {
    const repo = makeRepo();
    try {
        const result = await applyMitosis(repo.dir, repo.diff, {
            strategy: "file",
            branch: "oc-pilot/mitosis-failing",
            testCommand: 'node -e "process.exit(1)"',
        });
        assert.equal(result.status, "failed");
        assert.equal(result.commits.length, 1);
        assert.equal(result.commits[0]?.tests, "fail");
        assert.match(result.summary, /\[MITOSIS FAILED\]/);
        assert.equal(git(["rev-parse", "--verify", "refs/heads/oc-pilot/mitosis-failing"], repo.dir).trim(), result.commits[0]?.sha);
    }
    finally {
        rmSync(repo.dir, { recursive: true, force: true });
    }
});
test("applyMitosis refuses an existing branch without force", async () => {
    const repo = makeRepo();
    try {
        await applyMitosis(repo.dir, repo.diff, {
            strategy: "file",
            branch: "oc-pilot/mitosis-existing",
            runTests: false,
        });
        await assert.rejects(() => applyMitosis(repo.dir, repo.diff, {
            strategy: "file",
            branch: "oc-pilot/mitosis-existing",
            runTests: false,
        }), /Ветка уже существует/);
    }
    finally {
        rmSync(repo.dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=mitosis.test.js.map