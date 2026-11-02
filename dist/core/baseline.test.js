import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendToBaseline, filterAnalysisText, filterFindings, findingFingerprint, loadBaseline, writeBaseline, } from "./baseline.js";
const CRITICAL = { severity: "critical", location: "wallet.ts:10", text: "nil deref" };
const OTHER = { severity: "warning", location: "wallet.ts:20", text: "unused variable" };
test("fingerprints are stable across line shifts and whitespace", () => {
    assert.equal(findingFingerprint(CRITICAL), findingFingerprint(CRITICAL));
    const shifted = { severity: "critical", location: "wallet.ts:999", text: "nil deref" };
    assert.equal(findingFingerprint(CRITICAL), findingFingerprint(shifted));
    const spaced = { severity: "critical", location: "wallet.ts:10", text: "nil   deref" };
    assert.equal(findingFingerprint(CRITICAL), findingFingerprint(spaced));
});
test("fingerprints change with severity, file or text", () => {
    const base = findingFingerprint(CRITICAL);
    assert.notEqual(findingFingerprint({ ...CRITICAL, severity: "warning" }), base);
    assert.notEqual(findingFingerprint({ ...CRITICAL, location: "other.ts:10" }), base);
    assert.notEqual(findingFingerprint({ ...CRITICAL, text: "other problem" }), base);
});
test("writeBaseline and loadBaseline round-trip with dedupe", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-baseline-io-"));
    try {
        const written = writeBaseline(dir, [CRITICAL, { ...CRITICAL, location: "wallet.ts:55" }, OTHER]);
        assert.equal(written.count, 2);
        const loaded = loadBaseline(dir);
        assert.equal(loaded.count, 2);
        assert.ok(loaded.fingerprints.has(findingFingerprint(CRITICAL)));
        assert.ok(loaded.fingerprints.has(findingFingerprint(OTHER)));
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("a corrupt baseline file loads as empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-baseline-broken-"));
    try {
        mkdirSync(join(dir, ".oc-pilot"), { recursive: true });
        writeFileSync(join(dir, ".oc-pilot", "baseline.json"), "{ not json", "utf8");
        const loaded = loadBaseline(dir);
        assert.equal(loaded.count, 0);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("filterFindings keeps unknown findings and counts known ones", () => {
    const known = new Set([findingFingerprint(CRITICAL)]);
    const { kept, knownCount } = filterFindings([CRITICAL, OTHER], known);
    assert.equal(kept.length, 1);
    assert.equal(kept[0]?.text, "unused variable");
    assert.equal(knownCount, 1);
});
test("filterAnalysisText removes known bullets and keeps everything else", () => {
    const text = [
        "### Analysis: two findings.",
        "",
        "#### Findings / Actions",
        `- **🔴 Critical \`wallet.ts:10\`**: nil deref`,
        `- **🟡 Warning \`wallet.ts:20\`**: unused variable`,
        "",
        "#### Solution",
        "none",
    ].join("\n");
    const known = new Set([findingFingerprint(CRITICAL)]);
    const filtered = filterAnalysisText(text, known);
    assert.ok(!filtered.includes("nil deref"));
    assert.ok(filtered.includes("unused variable"));
    assert.ok(filtered.includes("#### Solution"));
    assert.ok(filtered.includes("### Analysis: two findings."));
});
test("filterAnalysisText leaves text without a findings section untouched", () => {
    const lgtm = "LGTM: no critical issues found.";
    assert.equal(filterAnalysisText(lgtm, new Set([findingFingerprint(CRITICAL)])), lgtm);
});
test("appendToBaseline merges new findings into an existing baseline", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-baseline-append-"));
    try {
        writeBaseline(dir, [CRITICAL]);
        appendToBaseline(dir, [CRITICAL, OTHER]);
        const loaded = loadBaseline(dir);
        assert.equal(loaded.count, 2);
        assert.ok(loaded.fingerprints.has(findingFingerprint(CRITICAL)));
        assert.ok(loaded.fingerprints.has(findingFingerprint(OTHER)));
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=baseline.test.js.map