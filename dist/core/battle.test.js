import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runBattle } from "./battle.js";
const DIFF = "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n";
function fakeRunner(responses, calls = []) {
    return (args) => {
        calls.push(args);
        const command = args[0] ?? "";
        const payload = responses[command];
        return { exitCode: payload === undefined ? 0 : 0, json: (payload ?? {}), stderr: "" };
    };
}
test("runBattle passes when the patch has no high findings and tests pass", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-battle-"));
    try {
        const calls = [];
        const runner = fakeRunner({
            fix: {
                patch: DIFF,
                files: ["src/app.ts"],
                applied: false,
                tests: { exitCode: 0, timedOut: false },
            },
            review: { findings: [] },
            sast: { findings: [] },
            authz: { findings: [] },
            "test-guard": { findings: [] },
        }, calls);
        const report = runBattle(dir, { task: "fix the retry", diff: DIFF, runner });
        assert.equal(report.status, "pass");
        assert.equal(report.rounds.length, 1);
        assert.equal(report.rounds[0]?.findings.length, 0);
        assert.equal(report.rounds[0]?.tests?.passed, true);
        assert.ok(calls.some((args) => args[0] === "review" && args.includes("--diff")));
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("runBattle fails without apply when the hacker finds a critical issue", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-battle-"));
    try {
        const runner = fakeRunner({
            fix: { patch: DIFF, files: ["src/app.ts"], applied: false, tests: null },
            review: { findings: [{ severity: "critical", text: "command injection", location: "src/app.ts:1" }] },
            sast: { findings: [] },
            authz: { findings: [] },
            "test-guard": { findings: [] },
        });
        const report = runBattle(dir, { task: "fix the retry", diff: DIFF, runner });
        assert.equal(report.status, "fail");
        assert.match(report.reason, /--apply/);
        assert.equal(report.rounds[0]?.findings[0]?.source, "review");
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("runBattle stops when the coder proposes no patch", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-battle-"));
    try {
        const runner = fakeRunner({ fix: { applied: false, error: "no patch" } });
        const report = runBattle(dir, { task: "fix the retry", diff: DIFF, runner });
        assert.equal(report.status, "stopped");
        assert.equal(report.rounds.length, 1);
        assert.match(report.reason, /no patch/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("runBattle retries on the working tree after an applied patch", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-battle-"));
    try {
        const calls = [];
        let reviewRound = 0;
        const runner = (args) => {
            calls.push(args);
            const command = args[0];
            if (command === "fix") {
                return {
                    exitCode: 0,
                    json: { patch: DIFF, files: ["src/app.ts"], applied: true, tests: { exitCode: 0, timedOut: false } },
                    stderr: "",
                };
            }
            if (command === "review") {
                reviewRound += 1;
                return {
                    exitCode: 0,
                    json: {
                        findings: reviewRound === 1
                            ? [{ severity: "high", text: "missing auth", location: "src/app.ts:2" }]
                            : [],
                    },
                    stderr: "",
                };
            }
            return { exitCode: 0, json: { findings: [] }, stderr: "" };
        };
        const report = runBattle(dir, { task: "fix the retry", diff: DIFF, apply: true, rounds: 2, runner });
        assert.equal(report.status, "pass");
        assert.equal(report.rounds.length, 2);
        const coderCalls = calls.filter((args) => args[0] === "fix");
        assert.equal(coderCalls.length, 2);
        assert.ok(coderCalls[0]?.includes("--diff"));
        assert.ok(!coderCalls[1]?.includes("--diff"), "round 2 should use the working tree");
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=battle.test.js.map