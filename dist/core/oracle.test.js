import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseOracleCorpus, renderOracle, runOracle, } from "./oracle.js";
function git(args, cwd) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0)
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout;
}
function harness(multiplier, exit) {
    return [
        'import { readFileSync } from "node:fs";',
        'const value = JSON.parse(readFileSync(process.argv[2], "utf8"));',
        `console.log(JSON.stringify({ result: value * ${String(multiplier)} }));`,
        exit ? "if (value > 0) process.exitCode = 1;" : "",
        "",
    ].join("\n");
}
function makeRepo(mode) {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-oracle-"));
    git(["init", "-q"], dir);
    git(["config", "user.email", "test@example.com"], dir);
    git(["config", "user.name", "Test"], dir);
    git(["config", "core.autocrlf", "false"], dir);
    writeFileSync(join(dir, "harness.mjs"), harness(2, false), "utf8");
    writeFileSync(join(dir, "notes.txt"), "one\n", "utf8");
    git(["add", "."], dir);
    git(["commit", "-m", "init"], dir);
    if (mode === "multiplier")
        writeFileSync(join(dir, "harness.mjs"), harness(3, false), "utf8");
    else if (mode === "exit")
        writeFileSync(join(dir, "harness.mjs"), harness(2, true), "utf8");
    else
        writeFileSync(join(dir, "notes.txt"), "two\n", "utf8");
    return { dir, diff: git(["diff"], dir) };
}
test("parseOracleCorpus accepts arrays, wrapped cases and a single case", () => {
    assert.deepEqual(parseOracleCorpus('[{"id":"a","input":1},2]'), [
        { id: "a", input: 1 },
        { id: "case-2", input: 2 },
    ]);
    assert.deepEqual(parseOracleCorpus('{"cases":[{"input":3}]}'), [{ id: "case-1", input: 3 }]);
    assert.deepEqual(parseOracleCorpus('{"id":"one","input":1}'), [{ id: "one", input: 1 }]);
    assert.deepEqual(parseOracleCorpus("[]"), []);
    assert.equal(parseOracleCorpus("not json"), undefined);
});
test("runOracle reports a changed output with before and after values", async () => {
    const repo = makeRepo("multiplier");
    try {
        const report = await runOracle(repo.dir, repo.diff, [{ id: "two", input: 2 }], {
            command: "node harness.mjs {input}",
            timeoutMs: 20_000,
            source: "staged",
        });
        assert.equal(report.status, "changed");
        assert.equal(report.changed, 1);
        assert.match(report.summary, /\[BEHAVIOR CHANGED\]/);
        assert.equal(report.results[0]?.before.output, '{"result":4}');
        assert.equal(report.results[0]?.after.output, '{"result":6}');
        assert.equal(report.results[0]?.reason, "output");
    }
    finally {
        rmSync(repo.dir, { recursive: true, force: true });
    }
});
test("runOracle reports the same behavior when the diff is unrelated", async () => {
    const repo = makeRepo("unrelated");
    try {
        const report = await runOracle(repo.dir, repo.diff, [{ id: "two", input: 2 }], {
            command: "node harness.mjs {input}",
            timeoutMs: 20_000,
        });
        assert.equal(report.status, "same");
        assert.equal(report.changed, 0);
        assert.match(report.summary, /\[BEHAVIOR SAME\]/);
    }
    finally {
        rmSync(repo.dir, { recursive: true, force: true });
    }
});
test("runOracle notices a changed exit code", async () => {
    const repo = makeRepo("exit");
    try {
        const report = await runOracle(repo.dir, repo.diff, [{ id: "two", input: 2 }], {
            command: "node harness.mjs {input}",
            timeoutMs: 20_000,
        });
        assert.equal(report.status, "changed");
        assert.equal(report.results[0]?.reason, "exit code");
        assert.equal(report.results[0]?.before.exitCode, 0);
        assert.equal(report.results[0]?.after.exitCode, 1);
    }
    finally {
        rmSync(repo.dir, { recursive: true, force: true });
    }
});
test("runOracle requires the {input} placeholder", async () => {
    const repo = makeRepo("multiplier");
    try {
        await assert.rejects(() => runOracle(repo.dir, repo.diff, [{ id: "two", input: 2 }], { command: "node harness.mjs" }), /должна содержать \{input\}/);
    }
    finally {
        rmSync(repo.dir, { recursive: true, force: true });
    }
});
test("renderOracle shows the changed case and both outputs", () => {
    const report = {
        source: "staged",
        command: "node harness.mjs {input}",
        cases: 1,
        changed: 1,
        status: "changed",
        results: [
            {
                id: "two",
                input: 2,
                before: { exitCode: 0, output: '{"result":4}', timedOut: false },
                after: { exitCode: 0, output: '{"result":6}', timedOut: false },
                changed: true,
                reason: "output",
            },
        ],
        summary: "[BEHAVIOR CHANGED]: 1 из 1 кейсов дали другой результат.",
        content: "",
    };
    const text = renderOracle(report);
    assert.match(text, /Oracle: changed/);
    assert.match(text, /\[CHANGED\] two/);
    assert.match(text, /\{"result":4\}/);
    assert.match(text, /\{"result":6\}/);
});
//# sourceMappingURL=oracle.test.js.map