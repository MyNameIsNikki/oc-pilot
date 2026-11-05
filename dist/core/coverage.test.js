import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { changedCoverage, changedLines, coverageGaps, describeCoverage, formatCoverageGaps, loadCoverage, parseCobertura, parseGoCover, parseIstanbul, parseLcov, sniffFormat, } from "./coverage.js";
const LCOV = [
    "TN:",
    "SF:/work/app/src/a.ts",
    "DA:10,1",
    "DA:11,0",
    "DA:12,3",
    "end_of_record",
    "SF:/work/app/src/b.ts",
    "DA:1,0",
    "end_of_record",
    "",
].join("\n");
const ISTANBUL = JSON.stringify({
    "/work/app/src/a.ts": {
        statementMap: {
            0: { start: { line: 10 }, end: { line: 10 } },
            1: { start: { line: 11 }, end: { line: 11 } },
        },
        s: { 0: 1, 1: 0 },
        fnMap: { 0: { decl: { start: { line: 20 } }, loc: { start: { line: 20 } } } },
        f: { 0: 0 },
    },
});
const COBERTURA = [
    "<coverage>",
    '  <packages><package><classes>',
    '    <class filename="src/a.py">',
    '      <lines>',
    '        <line number="3" hits="0"/>',
    '        <line number="4" hits="2"/>',
    "      </lines>",
    "    </class>",
    "  </classes></package></packages>",
    "</coverage>",
].join("\n");
const GO_COVER = ["mode: set", "github.com/acme/app/src/a.go:10.1,12.2 1 0", "github.com/acme/app/src/a.go:20.1,20.9 1 1", ""].join("\n");
const DIFF = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,3 +10,4 @@",
    " context",
    "-old",
    "+new one",
    "+new two",
    " keep",
    "@@ -30,1 +31,2 @@",
    "+last added",
    "",
].join("\n");
test("parseLcov keeps covered and executable lines apart", () => {
    const files = parseLcov(LCOV);
    const a = files.get("/work/app/src/a.ts");
    assert.ok(a);
    assert.deepEqual([...a.executable].sort((x, y) => x - y), [10, 11, 12]);
    assert.deepEqual([...a.covered].sort((x, y) => x - y), [10, 12]);
});
test("parseIstanbul reads statements and functions", () => {
    const files = parseIstanbul(ISTANBUL);
    const a = files.get("/work/app/src/a.ts");
    assert.ok(a);
    assert.equal(a.covered.has(10), true);
    assert.equal(a.covered.has(11), false);
    assert.equal(a.covered.has(20), false);
    assert.equal(a.executable.has(20), true);
});
test("parseCobertura reads class lines", () => {
    const files = parseCobertura(COBERTURA);
    const a = files.get("src/a.py");
    assert.ok(a);
    assert.equal(a.covered.has(4), true);
    assert.equal(a.covered.has(3), false);
});
test("parseGoCover expands statement blocks into lines", () => {
    const files = parseGoCover(GO_COVER);
    const a = files.get("github.com/acme/app/src/a.go");
    assert.ok(a);
    assert.deepEqual([...a.executable].sort((x, y) => x - y), [10, 11, 12, 20]);
    assert.equal(a.covered.has(20), true);
    assert.equal(a.covered.has(11), false);
});
test("sniffFormat detects every supported report", () => {
    assert.equal(sniffFormat(LCOV), "lcov");
    assert.equal(sniffFormat(ISTANBUL), "istanbul");
    assert.equal(sniffFormat(COBERTURA), "cobertura");
    assert.equal(sniffFormat(GO_COVER), "go");
    assert.equal(sniffFormat("hello"), undefined);
});
test("changedLines returns added line numbers per file", () => {
    const lines = changedLines(DIFF);
    assert.deepEqual([...lines.get("src/a.ts")].sort((x, y) => x - y), [11, 12, 31]);
});
test("coverageGaps intersects changed lines with uncovered ones", () => {
    const report = {
        path: "lcov.info",
        format: "lcov",
        files: new Map([
            ["src/a.ts", { executable: new Set([11, 12, 31]), covered: new Set([11]) }],
        ]),
    };
    const summary = coverageGaps(report, changedLines(DIFF));
    assert.equal(summary.gaps.length, 1);
    assert.deepEqual(summary.gaps[0].uncovered, [12, 31]);
    assert.equal(summary.uncoveredLines, 2);
    assert.match(formatCoverageGaps(summary), /src\/a\.ts: 12, 31/);
    assert.match(describeCoverage(summary), /2 непокрытых/);
});
test("coverageGaps matches absolute and import-style paths by suffix", () => {
    const report = {
        path: "coverage.out",
        format: "go",
        files: new Map([
            ["github.com/acme/app/src/a.go", { executable: new Set([7]), covered: new Set() }],
        ]),
    };
    const summary = coverageGaps(report, new Map([["src/a.go", new Set([7])]]));
    assert.deepEqual(summary.gaps[0].uncovered, [7]);
});
test("coverageGaps reports changed files without coverage data", () => {
    const report = { path: "lcov.info", format: "lcov", files: new Map() };
    const summary = coverageGaps(report, new Map([["src/a.ts", new Set([1])]]));
    assert.equal(summary.gaps.length, 0);
    assert.deepEqual(summary.missing, ["src/a.ts"]);
    assert.match(formatCoverageGaps(summary), /COVERAGE_MISSING/);
});
test("loadCoverage finds a default report and rejects unknown formats", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-coverage-"));
    try {
        mkdirSync(join(dir, "coverage"), { recursive: true });
        writeFileSync(join(dir, "coverage", "lcov.info"), LCOV, "utf8");
        const report = loadCoverage(dir);
        assert.ok(report);
        assert.equal(report.format, "lcov");
        assert.equal([...report.files.keys()].some((file) => file.endsWith("/src/a.ts")), true);
        writeFileSync(join(dir, "notes.txt"), "not a report", "utf8");
        assert.throws(() => loadCoverage(dir, "notes.txt"), /распознать формат/);
        assert.throws(() => loadCoverage(dir, "missing.info"), /не найден/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("changedCoverage counts executable and covered changed lines", () => {
    const report = {
        path: "lcov.info",
        format: "lcov",
        files: new Map([
            ["src/a.ts", { executable: new Set([1, 2, 3]), covered: new Set([1]) }],
        ]),
    };
    const counts = changedCoverage(report, new Map([["src/a.ts", new Set([1, 2, 4])]]));
    assert.equal(counts.executable, 2);
    assert.equal(counts.covered, 1);
    assert.equal(counts.uncovered, 1);
    assert.equal(counts.percent, 50);
});
test("changedCoverage ignores files without coverage data", () => {
    const report = {
        path: "lcov.info",
        format: "lcov",
        files: new Map([["src/a.ts", { executable: new Set([1]), covered: new Set([1]) }]]),
    };
    const counts = changedCoverage(report, new Map([
        ["src/a.ts", new Set([1])],
        ["src/missing.ts", new Set([1])],
    ]));
    assert.equal(counts.executable, 1);
    assert.equal(counts.covered, 1);
    assert.equal(counts.uncovered, 0);
    assert.equal(counts.percent, 100);
});
test("changedCoverage returns a null percent when no changed line is executable", () => {
    const report = {
        path: "lcov.info",
        format: "lcov",
        files: new Map([["src/a.ts", { executable: new Set([1]), covered: new Set() }]]),
    };
    const counts = changedCoverage(report, new Map([["src/a.ts", new Set([9])]]));
    assert.equal(counts.executable, 0);
    assert.equal(counts.covered, 0);
    assert.equal(counts.uncovered, 0);
    assert.equal(counts.percent, null);
});
//# sourceMappingURL=coverage.test.js.map