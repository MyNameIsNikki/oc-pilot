import assert from "node:assert/strict";
import test from "node:test";
import { buildPreflightReport, renderPreflight, scopeDependencyIssues } from "./preflight.js";
const STATS = { files: 1, additions: 3, deletions: 0 };
function cleanAudit(issues) {
    return {
        audit: {
            packageName: "demo",
            declared: 1,
            imported: 1,
            scannedFiles: 2,
            truncated: false,
            lockfile: "package-lock.json",
            issues,
        },
        issues,
    };
}
function slopReport(index) {
    return {
        index,
        grade: "умеренно",
        categories: [],
        duplicates: [],
        deadExports: [],
        churn: [],
        todos: [],
        stats: { filesScanned: 3, linesScanned: 120, truncated: false },
    };
}
function slopDelta(deltaPoints) {
    return {
        base: "HEAD",
        index: 45,
        deltaPoints,
        categories: [{ id: "duplicates", label: "Дубликаты", introduced: 2, removed: 0 }],
        introduced: 2,
        removed: 0,
    };
}
function input(overrides = {}) {
    return {
        diff: { source: "git diff HEAD", stats: STATS },
        secrets: [],
        deps: cleanAudit([]),
        weaknesses: [],
        slop: { report: slopReport(45), delta: slopDelta(2) },
        ...overrides,
    };
}
const CRITICAL = {
    file: "src/app.ts",
    line: 4,
    kind: "AWS Access Key ID",
    severity: "critical",
    preview: "AKIA…",
};
test("scopeDependencyIssues keeps only issues touched by the change", () => {
    const issues = [
        { kind: "phantom", severity: "high", name: "axios", message: "not declared", files: ["src/app.ts"] },
        { kind: "phantom", severity: "high", name: "zod", message: "not declared", files: ["src/old.ts"] },
        { kind: "unused", severity: "medium", name: "left-pad", message: "unused" },
    ];
    const diff = ["diff --git a/src/app.ts b/src/app.ts", "+++ b/src/app.ts", '+import "left-pad";'].join("\n");
    const scoped = scopeDependencyIssues(issues, ["src/app.ts"], diff);
    assert.deepEqual(scoped.map((issue) => issue.name), ["axios", "left-pad"]);
});
test("preflight passes when every check is clean", () => {
    const report = buildPreflightReport(input());
    assert.equal(report.status, "pass");
    assert.deepEqual(report.checks.map((check) => check.status), ["pass", "pass", "pass", "pass"]);
    assert.equal(report.diff.files, 1);
});
test("a critical secret fails the run and a warning alone does not", () => {
    const failed = buildPreflightReport(input({ secrets: [CRITICAL] }));
    assert.equal(failed.status, "fail");
    assert.equal(failed.checks[0]?.status, "fail");
    assert.match(failed.checks[0].summary, /1 critical/);
    assert.deepEqual(failed.checks[0]?.details, ["src/app.ts:4 — AWS Access Key ID"]);
    const warned = buildPreflightReport(input({ secrets: [{ ...CRITICAL, severity: "warning" }] }));
    assert.equal(warned.status, "pass");
    assert.equal(warned.checks[0]?.status, "pass");
});
test("dependency issues fail only above the configured gate", () => {
    const high = { kind: "phantom", severity: "high", name: "axios", message: "not declared" };
    const medium = { kind: "unused", severity: "medium", name: "left-pad", message: "unused" };
    assert.equal(buildPreflightReport(input({ deps: cleanAudit([high]) })).status, "fail");
    assert.equal(buildPreflightReport(input({ deps: cleanAudit([high]), depsGate: "medium" })).status, "fail");
    assert.equal(buildPreflightReport(input({ deps: cleanAudit([medium]), depsGate: "high" })).status, "pass");
    assert.equal(buildPreflightReport(input({ deps: cleanAudit([medium]), depsGate: "low" })).status, "fail");
});
test("weakened tests fail the run", () => {
    const weakness = {
        file: "src/app.test.ts",
        line: 12,
        kind: "skipped-test",
        detail: "тест пропущен через it.skip",
    };
    const report = buildPreflightReport(input({ weaknesses: [weakness] }));
    assert.equal(report.status, "fail");
    assert.equal(report.checks[2]?.status, "fail");
    assert.match(report.checks[2].summary, /1 ослабление/);
    assert.deepEqual(report.checks[2]?.details, ["src/app.test.ts:12 — тест пропущен через it.skip"]);
});
test("slop growth above the limit fails the run", () => {
    const report = buildPreflightReport(input({ slop: { report: slopReport(55), delta: slopDelta(12) }, maxSlopDelta: 10 }));
    assert.equal(report.status, "fail");
    assert.equal(report.checks[3]?.status, "fail");
    assert.match(report.checks[3].summary, /\+12/);
    assert.deepEqual(report.checks[3]?.details, ["Дубликаты: +2"]);
});
test("skipped checks stay visible without failing", () => {
    const report = buildPreflightReport(input({
        disabled: ["secrets", "deps", "tests", "slop"],
    }));
    assert.equal(report.status, "pass");
    assert.deepEqual(report.checks.map((check) => check.status), ["skip", "skip", "skip", "skip"]);
    assert.match(report.checks[0].summary, /--no-secret-scan/);
    assert.match(report.checks[3].summary, /--no-slop/);
});
test("preflight does not claim a zero index for an empty diff", () => {
    const report = buildPreflightReport(input({
        diff: { source: "git diff HEAD", stats: { files: 0, additions: 0, deletions: 0 } },
        slop: { report: slopReport(47), delta: slopDelta(0) },
    }));
    const slop = report.checks.find((check) => check.id === "slop");
    assert.equal(slop?.status, "pass");
    assert.match(slop?.summary ?? "", /изменённых файлов нет/);
});
test("renderPreflight prints one verdict per check", () => {
    const report = buildPreflightReport(input({ secrets: [CRITICAL] }));
    const text = renderPreflight(report);
    assert.match(text, /FAIL {2}secrets/);
    assert.match(text, /OK {4}deps/);
    assert.match(text, /Preflight не пройден: 1 из 4 проверок\./);
    assert.ok(text.endsWith("\n"));
    const clean = renderPreflight(buildPreflightReport(input()));
    assert.match(clean, /Preflight пройден: 4 проверок, замечаний нет\./);
});
//# sourceMappingURL=preflight.test.js.map