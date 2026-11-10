import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SAMPLE_POLICY, checkWardenPolicy, globToRegExp, initWardenPolicy, parseWardenPolicy, readWardenPolicy, renderWardenPolicy, } from "./warden.js";
function makeDir() {
    return mkdtempSync(join(tmpdir(), "oc-pilot-warden-"));
}
const LOCK_DIFF = [
    "diff --git a/package-lock.json b/package-lock.json",
    "--- a/package-lock.json",
    "+++ b/package-lock.json",
    "@@ -1,1 +1,2 @@",
    " {",
    '+  "changed": true,',
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,1 +1,2 @@",
    " export const value = 1;",
    "+export const next = eval(userInput);",
    "",
].join("\n");
const CLEAN_DIFF = [
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,1 +1,2 @@",
    " export const value = 1;",
    "+export const next = 2;",
    "diff --git a/src/app.test.ts b/src/app.test.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/app.test.ts",
    "@@ -0,0 +1,1 @@",
    '+test("next", () => {});',
    "",
].join("\n");
test("globToRegExp matches files, wildcards and double wildcards", () => {
    assert.ok(globToRegExp("package-lock.json").test("package-lock.json"));
    assert.ok(!globToRegExp("package-lock.json").test("x/package-lock.json"));
    assert.ok(globToRegExp(".env.*").test(".env.local"));
    assert.ok(globToRegExp("**/*.pem").test("certs/server.pem"));
    assert.ok(!globToRegExp("**/*.pem").test("certs/server.pem.bak"));
});
test("parseWardenPolicy accepts rules and rejects malformed input", () => {
    const policy = parseWardenPolicy(JSON.stringify({
        version: 1,
        rules: [
            { kind: "forbid-paths", name: "env", patterns: [".env"] },
            { kind: "nonsense" },
            { kind: "max-files", max: 5 },
        ],
    }));
    assert.equal(policy?.rules.length, 2);
    assert.equal(policy?.rules[0]?.kind, "forbid-paths");
    assert.equal(policy?.rules[1]?.max, 5);
    assert.equal(parseWardenPolicy("not json"), undefined);
    assert.equal(parseWardenPolicy('{"version":2,"rules":[]}'), undefined);
});
test("checkWardenPolicy flags lockfiles, eval and missing tests", () => {
    const report = checkWardenPolicy(LOCK_DIFF, SAMPLE_POLICY);
    assert.equal(report.status, "violation");
    assert.match(report.summary, /\[POLICY VIOLATION\]/);
    const rules = new Set(report.violations.map((violation) => violation.rule));
    assert.ok(rules.has("lockfiles"));
    assert.ok(rules.has("no-eval"));
    assert.ok(rules.has("tests-required"));
    const evalViolation = report.violations.find((violation) => violation.rule === "no-eval");
    assert.equal(evalViolation?.file, "src/app.ts");
    assert.match(evalViolation?.evidence ?? "", /eval/);
});
test("checkWardenPolicy passes a clean diff with tests", () => {
    const report = checkWardenPolicy(CLEAN_DIFF, SAMPLE_POLICY);
    assert.equal(report.status, "pass", report.summary);
    assert.deepEqual(report.violations, []);
    assert.match(report.summary, /\[POLICY PASS\]/);
});
test("checkWardenPolicy enforces max-files, deps and extensions", () => {
    const diff = [
        "diff --git a/package.json b/package.json",
        "--- a/package.json",
        "+++ b/package.json",
        "@@ -1,2 +1,3 @@",
        '   "dependencies": {',
        '+    "left-pad": "^1.0.0",',
        "   }",
        "",
    ].join("\n");
    const policy = {
        version: 1,
        rules: [
            { kind: "forbid-deps", name: "no-left-pad", patterns: ["left-pad"] },
            { kind: "forbid-extensions", name: "no-bin", patterns: ["exe", "dll"] },
            { kind: "max-files", name: "tiny", max: 0 },
        ],
    };
    const report = checkWardenPolicy(diff, policy);
    assert.equal(report.status, "violation");
    const rules = new Set(report.violations.map((violation) => violation.rule));
    assert.ok(rules.has("no-left-pad"));
    assert.ok(rules.has("tiny"));
});
test("initWardenPolicy writes the sample policy and renderWardenPolicy lists it", () => {
    const dir = makeDir();
    try {
        const result = initWardenPolicy(dir, false);
        assert.equal(result.written, ".oc-pilot/policy.json");
        const stored = readWardenPolicy(dir);
        assert.equal(stored?.rules.length, SAMPLE_POLICY.rules.length);
        assert.throws(() => initWardenPolicy(dir, false), /уже существует/);
        const text = renderWardenPolicy(stored ?? SAMPLE_POLICY);
        assert.match(text, /no-eval/);
        assert.match(text, /tests-required/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=warden.test.js.map