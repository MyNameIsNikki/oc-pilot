import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateTribunal,
  buildTribunalPrompt,
  isTribunalLens,
  parseTribunalFindings,
  parseTribunalLens,
  renderTribunal,
  type TribunalFinding,
} from "./tribunal.js";

test("buildTribunalPrompt focuses on the lens and asks for strict JSON", () => {
  const security = buildTribunalPrompt("security", "diff --git a/x b/x");
  assert.match(security, /security only/);
  assert.match(security, /strict JSON/);
  assert.match(security, /diff --git a\/x b\/x/);

  const maintainability = buildTribunalPrompt("maintainability", "diff");
  assert.match(maintainability, /maintainability only/);
  assert.match(maintainability, /duplication/);
});

test("parseTribunalFindings accepts fenced JSON and normalizes severity", () => {
  const parsed = parseTribunalFindings(
    '```json\n{"findings":[{"severity":"high","file":"src/x.ts","line":4,"issue":"missing authz"},{"severity":"weird","issue":"no evidence"}]}\n```',
    "security",
  );
  assert.equal(parsed?.length, 2);
  assert.equal(parsed?.[0]?.lens, "security");
  assert.equal(parsed?.[0]?.severity, "high");
  assert.equal(parsed?.[1]?.severity, "medium");
  assert.equal(parseTribunalFindings("not json", "security"), undefined);
  assert.deepEqual(parseTribunalFindings('{"findings":[]}', "correctness"), []);
});

test("aggregateTribunal requires the configured number of lenses", () => {
  const findings: TribunalFinding[] = [
    { lens: "security", severity: "high", file: "src/x.ts", line: 4, issue: "missing authz" },
    { lens: "correctness", severity: "medium", file: "src/x.ts", line: 4, issue: "missing authz" },
    { lens: "security", severity: "low", file: "src/y.ts", issue: "weak name" },
  ];
  const report = aggregateTribunal(["security", "correctness", "maintainability"], findings, 2);
  assert.equal(report.status, "consensus");
  assert.equal(report.verdicts.length, 2);
  const consensus = report.verdicts.find((verdict) => verdict.consensus);
  assert.deepEqual(consensus?.lenses, ["correctness", "security"]);
  assert.equal(consensus?.severity, "high");
  assert.match(report.summary, /\[TRIBUNAL CONSENSUS\]/);
  assert.match(renderTribunal(report), /CONSENSUS/);
});

test("aggregateTribunal reports split and clean", () => {
  const split = aggregateTribunal(
    ["security", "correctness"],
    [{ lens: "security", severity: "high", issue: "only one lens" }],
    2,
  );
  assert.equal(split.status, "split");
  assert.equal(split.verdicts[0]?.consensus, false);
  assert.match(split.summary, /\[TRIBUNAL SPLIT\]/);

  const clean = aggregateTribunal(["security"], [], 1);
  assert.equal(clean.status, "clean");
  assert.match(clean.summary, /\[TRIBUNAL CLEAN\]/);
});

test("lens helpers validate names", () => {
  assert.equal(isTribunalLens("security"), true);
  assert.equal(isTribunalLens("nonsense"), false);
  assert.equal(parseTribunalLens("correctness"), "correctness");
  assert.throws(() => parseTribunalLens("nonsense"), /unknown lens/);
});
