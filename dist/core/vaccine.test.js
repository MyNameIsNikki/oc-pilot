import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildVaccinePrompt, clearVaccines, forgetVaccine, listVaccines, runVaccines, storeVaccine, verifyVaccine, } from "./vaccine.js";
function git(args, cwd) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0)
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout;
}
function makeRepo() {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-vaccine-"));
    git(["init", "-q"], dir);
    git(["config", "user.email", "test@example.com"], dir);
    git(["config", "user.name", "Test"], dir);
    git(["config", "core.autocrlf", "false"], dir);
    writeFileSync(join(dir, "app.mjs"), "export const value = 1;\n", "utf8");
    git(["add", "."], dir);
    git(["commit", "-m", "bug"], dir);
    const bug = git(["rev-parse", "HEAD"], dir).trim();
    writeFileSync(join(dir, "app.mjs"), "export const value = 2;\n", "utf8");
    git(["add", "."], dir);
    git(["commit", "-m", "fix"], dir);
    const fix = git(["rev-parse", "HEAD"], dir).trim();
    return { dir, bug, fix };
}
function hypothesis(assertion) {
    return {
        test: [
            'import test from "node:test";',
            'import assert from "node:assert/strict";',
            'import { value } from "../app.mjs";',
            `test("value", () => { assert.equal(value, ${assertion}); });`,
            "",
        ].join("\n"),
        reason: `value should be ${assertion}`,
    };
}
test("buildVaccinePrompt asks for a test that separates bug and fix", () => {
    const prompt = buildVaccinePrompt("diff --git a/app.mjs b/app.mjs", "bug1234", "fix5678", "negative discount");
    assert.match(prompt, /FAIL on the buggy parent/);
    assert.match(prompt, /bug1234/);
    assert.match(prompt, /fix5678/);
    assert.match(prompt, /strict JSON/);
    assert.match(prompt, /negative discount/);
    assert.match(prompt, /diff --git a\/app\.mjs/);
});
test("verifyVaccine accepts a test that fails on the bug and passes on the fix", async () => {
    const repo = makeRepo();
    try {
        const result = await verifyVaccine(repo.dir, repo.bug, repo.fix, hypothesis("2"), { timeoutMs: 20_000 });
        assert.equal(result.status, "verified", result.summary);
        assert.match(result.summary, /\[VACCINE VERIFIED\]/);
        assert.ok(result.bugOutput && result.fixOutput);
    }
    finally {
        rmSync(repo.dir, { recursive: true, force: true });
    }
});
test("verifyVaccine rejects a test that passes on the bug or fails on the fix", async () => {
    const repo = makeRepo();
    try {
        const passesOnBug = await verifyVaccine(repo.dir, repo.bug, repo.fix, hypothesis("1"), { timeoutMs: 20_000 });
        assert.equal(passesOnBug.status, "rejected");
        assert.match(passesOnBug.summary, /проходит на баге/);
        const failsBoth = await verifyVaccine(repo.dir, repo.bug, repo.fix, hypothesis("999"), { timeoutMs: 20_000 });
        assert.equal(failsBoth.status, "rejected");
        assert.match(failsBoth.summary, /падает и на исправленном/);
    }
    finally {
        rmSync(repo.dir, { recursive: true, force: true });
    }
});
test("verifyVaccine refuses identical bug and fix refs", async () => {
    const repo = makeRepo();
    try {
        await assert.rejects(() => verifyVaccine(repo.dir, repo.fix, repo.fix, hypothesis("2")), /один коммит/);
    }
    finally {
        rmSync(repo.dir, { recursive: true, force: true });
    }
});
test("storeVaccine, listVaccines and runVaccines keep a working vaccine", async () => {
    const repo = makeRepo();
    try {
        const record = storeVaccine(repo.dir, {
            bug: repo.bug,
            fix: repo.fix,
            command: "node --test {file}",
            reason: "value should be 2",
            test: hypothesis("2").test,
        });
        assert.match(record.id, /^vac_/);
        assert.ok(existsSync(join(repo.dir, record.testFile)));
        const listed = listVaccines(repo.dir);
        assert.equal(listed.vaccines.length, 1);
        assert.match(listed.content, /value should be 2/);
        const run = await runVaccines(repo.dir, { timeoutMs: 20_000 });
        assert.equal(run.total, 1);
        assert.equal(run.passed, 1);
        assert.equal(run.failed, 0);
        assert.match(run.summary, /\[VACCINES PASSED\]/);
    }
    finally {
        rmSync(repo.dir, { recursive: true, force: true });
    }
});
test("forgetVaccine and clearVaccines remove stored vaccines", () => {
    const repo = makeRepo();
    try {
        const first = storeVaccine(repo.dir, {
            bug: repo.bug,
            fix: repo.fix,
            command: "node --test {file}",
            reason: "first",
            test: hypothesis("2").test,
        });
        const forgotten = forgetVaccine(repo.dir, first.id);
        assert.equal(forgotten.removed, true);
        assert.equal(forgotten.remaining, 0);
        assert.equal(existsSync(join(repo.dir, first.testFile)), false);
        storeVaccine(repo.dir, {
            bug: repo.bug,
            fix: repo.fix,
            command: "node --test {file}",
            reason: "second",
            test: hypothesis("3").test,
        });
        assert.equal(clearVaccines(repo.dir).removed, 1);
        assert.deepEqual(listVaccines(repo.dir).vaccines, []);
    }
    finally {
        rmSync(repo.dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=vaccine.test.js.map