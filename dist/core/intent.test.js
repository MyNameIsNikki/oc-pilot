import assert from "node:assert/strict";
import test from "node:test";
import { buildIntentPrompt, buildSphinxPrompt, evaluateIntent, parseCriteria, parseIntentResults, parseSphinxReport, renderIntent, renderSphinx, } from "./intent.js";
test("parseCriteria accepts checklists, numbered lists and plain lines", () => {
    const text = [
        "# Acceptance",
        "- [ ] reset token expires",
        "- [x] email is sent",
        "1. audit log entry",
        "* plain criterion",
        "// comment",
        "",
    ].join("\n");
    assert.deepEqual(parseCriteria(text), [
        "reset token expires",
        "email is sent",
        "audit log entry",
        "plain criterion",
    ]);
    assert.deepEqual(parseCriteria("   \n\n"), []);
});
test("buildIntentPrompt lists criteria and asks for strict JSON verdicts", () => {
    const prompt = buildIntentPrompt(["reset works", "audit logged"], "diff --git a/x b/x", "auth flow");
    assert.match(prompt, /strict JSON/);
    assert.match(prompt, /reset works/);
    assert.match(prompt, /audit logged/);
    assert.match(prompt, /auth flow/);
    assert.match(prompt, /diff --git a\/x b\/x/);
});
test("parseIntentResults aligns verdicts and fills missing criteria", () => {
    const criteria = ["reset works", "audit logged", "email sent"];
    const parsed = parseIntentResults('```json\n{"criteria":[{"text":"reset works","status":"met","evidence":"src/auth.ts"},{"text":"audit logged","status":"unmet","evidence":"no log call"}]}\n```', criteria);
    assert.equal(parsed?.length, 3);
    assert.equal(parsed?.[0]?.status, "met");
    assert.equal(parsed?.[0]?.evidence, "src/auth.ts");
    assert.equal(parsed?.[1]?.status, "unmet");
    assert.equal(parsed?.[2]?.status, "unverifiable");
    assert.equal(parseIntentResults("not json", criteria), undefined);
});
test("evaluateIntent reports met, partial, unmet and inconclusive", () => {
    const criteria = ["a", "b"];
    const result = (status) => ({
        text: "x",
        status,
        evidence: "e",
    });
    const met = evaluateIntent(criteria, [result("met"), result("met")], "staged");
    assert.equal(met.status, "met");
    assert.match(met.summary, /\[INTENT MET\]/);
    const unmet = evaluateIntent(criteria, [result("met"), result("unmet")], "staged");
    assert.equal(unmet.status, "unmet");
    assert.equal(unmet.counts.unmet, 1);
    assert.match(unmet.summary, /\[INTENT UNMET\]/);
    const partial = evaluateIntent(criteria, [result("partial"), result("met")], "staged");
    assert.equal(partial.status, "partial");
    const inconclusive = evaluateIntent(criteria, [result("unverifiable"), result("met")], "staged");
    assert.equal(inconclusive.status, "inconclusive");
});
test("buildSphinxPrompt asks for questions, assumptions and criteria", () => {
    const prompt = buildSphinxPrompt("add password reset", "existing auth module");
    assert.match(prompt, /questions/);
    assert.match(prompt, /assumptions/);
    assert.match(prompt, /criteria/);
    assert.match(prompt, /add password reset/);
    assert.match(prompt, /existing auth module/);
});
test("parseSphinxReport marks missing decisions as ambiguous", () => {
    const ambiguous = parseSphinxReport('{"questions":["who can reset?"],"assumptions":["email is verified"],"criteria":["expired token returns 401"]}');
    assert.equal(ambiguous?.status, "ambiguous");
    assert.equal(ambiguous?.questions.length, 1);
    assert.equal(ambiguous?.assumptions.length, 1);
    assert.equal(ambiguous?.criteria.length, 1);
    assert.match(ambiguous?.summary ?? "", /\[REQUIREMENTS AMBIGUOUS\]/);
    const clear = parseSphinxReport('{"questions":[],"assumptions":[],"criteria":["reset works"]}');
    assert.equal(clear?.status, "clear");
    assert.match(clear?.summary ?? "", /\[REQUIREMENTS CLEAR\]/);
    assert.equal(parseSphinxReport("not json"), undefined);
});
test("renderIntent and renderSphinx return the rendered content", () => {
    const report = evaluateIntent(["a"], [{ text: "a", status: "met", evidence: "src/a.ts" }], "staged");
    assert.match(renderIntent(report), /Intent: met/);
    const sphinx = parseSphinxReport('{"questions":["q"],"assumptions":[],"criteria":[]}');
    assert.ok(sphinx);
    assert.match(renderSphinx(sphinx), /Sphinx: ambiguous/);
});
//# sourceMappingURL=intent.test.js.map