import assert from "node:assert/strict";
import test from "node:test";
import { buildDiffFacts, buildPolygraphPrompt, checkClaim, evaluatePolygraph, parsePolygraphClaims, renderPolygraph, } from "./polygraph.js";
const FULL_DIFF = [
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,1 +1,3 @@",
    " export const value = 1;",
    "+export function login(req) {",
    "+  return eval(req.query.code);",
    "+}",
    "diff --git a/src/app.test.ts b/src/app.test.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/app.test.ts",
    "@@ -0,0 +1,2 @@",
    '+import { login } from "./app.js";',
    '+test("login", () => {});',
    "diff --git a/package.json b/package.json",
    "--- a/package.json",
    "+++ b/package.json",
    "@@ -1,3 +1,4 @@",
    " {",
    '+  "zod": "^3.23.8",',
    '   "name": "x"',
    " }",
    "diff --git a/old.ts b/old.ts",
    "deleted file mode 100644",
    "--- a/old.ts",
    "+++ /dev/null",
    "@@ -1,1 +0,0 @@",
    "-export const old = 1;",
    "",
].join("\n");
function claim(kind, text, polarity = "positive") {
    return { kind, text, polarity };
}
test("parsePolygraphClaims accepts strict JSON and normalizes unknown kinds", () => {
    const parsed = parsePolygraphClaims('```json\n{"claims":[{"kind":"test-added","text":"adds a regression test"},{"kind":"nonsense","text":"no new deps","negated":true}]}\n```');
    assert.equal(parsed?.length, 2);
    assert.deepEqual(parsed?.[0], { kind: "test-added", text: "adds a regression test", polarity: "positive" });
    assert.equal(parsed?.[1]?.kind, "other");
    assert.equal(parsed?.[1]?.polarity, "negative");
    assert.deepEqual(parsePolygraphClaims('{"claims":[]}'), []);
    assert.deepEqual(parsePolygraphClaims('{"claims":[{"text":""}]}'), []);
    assert.equal(parsePolygraphClaims("not json"), undefined);
});
test("buildPolygraphPrompt asks for strict JSON claims and includes the message and diff", () => {
    const prompt = buildPolygraphPrompt("adds a test and no behavior change", FULL_DIFF);
    assert.match(prompt, /strict JSON/);
    assert.match(prompt, /test-added/);
    assert.match(prompt, /negative/);
    assert.match(prompt, /adds a test and no behavior change/);
    assert.match(prompt, /diff --git a\/src\/app\.ts/);
});
test("buildDiffFacts extracts files, tests, dependencies and changed lines", () => {
    const facts = buildDiffFacts(FULL_DIFF);
    assert.deepEqual(facts.added, ["src/app.test.ts"]);
    assert.deepEqual(facts.removed, ["old.ts"]);
    assert.ok(facts.modified.includes("src/app.ts"));
    assert.ok(facts.modified.includes("package.json"));
    assert.equal(facts.testsTouched, true);
    assert.equal(facts.docsTouched, false);
    assert.equal(facts.behaviorTouched, true);
    assert.ok(facts.dependencies.includes("zod"));
    assert.ok(facts.addedLines.some((line) => line.path === "src/app.ts" && line.line === 2));
});
test("checkClaim supports, contradicts and leaves claims unverifiable", () => {
    const facts = buildDiffFacts(FULL_DIFF);
    assert.equal(checkClaim(claim("test-added", "adds a regression test"), facts).status, "supported");
    assert.equal(checkClaim(claim("file-added", "adds `src/app.test.ts`"), facts).status, "supported");
    assert.equal(checkClaim(claim("file-added", "adds `src/missing.ts`"), facts).status, "contradicted");
    assert.equal(checkClaim(claim("file-removed", "removes `old.ts`"), facts).status, "supported");
    assert.equal(checkClaim(claim("api-change", "changes the public API"), facts).status, "supported");
    assert.equal(checkClaim(claim("dependency", "adds `zod`"), facts).status, "supported");
    assert.equal(checkClaim(claim("dependency", "adds `lodash`"), facts).status, "contradicted");
    assert.equal(checkClaim(claim("docs", "updates the README"), facts).status, "contradicted");
    assert.equal(checkClaim(claim("security", "improves security"), facts).status, "contradicted");
    assert.equal(checkClaim(claim("behavior", "no behavior change", "negative"), facts).status, "contradicted");
    assert.equal(checkClaim(claim("refactor", "pure refactor"), facts).status, "unverifiable");
    assert.equal(checkClaim(claim("other", "makes the code nicer"), facts).status, "unverifiable");
});
test("evaluatePolygraph reports contradicted claims with evidence", () => {
    const report = evaluatePolygraph(FULL_DIFF, [claim("test-added", "adds a regression test"), claim("docs", "updates the README")], "staged");
    assert.equal(report.status, "contradicted");
    assert.equal(report.counts.supported, 1);
    assert.equal(report.counts.contradicted, 1);
    assert.match(report.summary, /\[CLAIM CONTRADICTED\]/);
    assert.match(report.content, /src\/app\.test\.ts/);
    assert.match(report.content, /документация не тронута/);
});
test("evaluatePolygraph verifies consistent claims and marks empty input inconclusive", () => {
    const verified = evaluatePolygraph(FULL_DIFF, [claim("test-added", "adds a regression test"), claim("file-added", "adds `src/app.test.ts`")], "staged");
    assert.equal(verified.status, "verified");
    assert.match(verified.summary, /\[POLYGRAPH VERIFIED\]/);
    const empty = evaluatePolygraph(FULL_DIFF, [], "staged");
    assert.equal(empty.status, "inconclusive");
    assert.match(empty.summary, /\[POLYGRAPH INCONCLUSIVE\]/);
    const other = evaluatePolygraph(FULL_DIFF, [claim("other", "improves the vibe")], "staged");
    assert.equal(other.status, "inconclusive");
});
test("renderPolygraph shows status, claims and evidence", () => {
    const report = evaluatePolygraph(FULL_DIFF, [claim("test-added", "adds a regression test")], "staged");
    const text = renderPolygraph(report);
    assert.match(text, /Polygraph: verified/);
    assert.match(text, /test-added/);
    assert.match(text, /src\/app\.test\.ts/);
});
//# sourceMappingURL=polygraph.test.js.map