import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnalysisFinding, SecretFinding } from "../types.js";
import {
  CRITICAL_RULE_ID,
  SARIF_VERSION,
  SECRET_RULE_ID,
  WARNING_RULE_ID,
  analysisFindingsToSarifResults,
  buildSarif,
  secretFindingsToSarifResults,
} from "./sarif.js";
import { VERSION } from "../version.js";

function secretFinding(overrides: Partial<SecretFinding> = {}): SecretFinding {
  return {
    file: "src/config.ts",
    line: 3,
    kind: "AWS Access Key ID",
    severity: "critical",
    preview: "[REDACTED:AWS Access Key ID]",
    ...overrides,
  };
}

test("secretFindingsToSarifResults maps severity to levels and rule id", () => {
  const results = secretFindingsToSarifResults([
    secretFinding(),
    secretFinding({ severity: "warning", kind: "Generic secret", line: 9 }),
  ]);
  assert.equal(results[0]?.ruleId, SECRET_RULE_ID);
  assert.equal(results[0]?.level, "error");
  assert.equal(results[0]?.file, "src/config.ts");
  assert.equal(results[0]?.line, 3);
  assert.equal(results[1]?.level, "warning");
});

test("secret sarif message never contains a raw secret", () => {
  const results = secretFindingsToSarifResults([secretFinding({ preview: "[REDACTED:AWS]" })]);
  assert.ok(results[0]!.message.includes("[REDACTED:AWS]"));
  assert.ok(!results[0]!.message.includes("AKIA"));
});

test("analysisFindingsToSarifResults maps severities and parses locations", () => {
  const findings: AnalysisFinding[] = [
    { severity: "critical", location: "src/a.ts:12", text: "SQL injection" },
    { severity: "warning", location: "src/a.ts:30:5", text: "Missing await" },
    { severity: "style", text: "No location" },
  ];
  const results = analysisFindingsToSarifResults(findings, process.cwd());
  assert.equal(results[0]?.ruleId, CRITICAL_RULE_ID);
  assert.equal(results[0]?.level, "error");
  assert.equal(results[0]?.file, "src/a.ts");
  assert.equal(results[0]?.line, 12);
  assert.equal(results[1]?.ruleId, WARNING_RULE_ID);
  assert.equal(results[1]?.level, "warning");
  assert.equal(results[1]?.line, 30);
  assert.equal(results[2]?.level, "note");
  assert.equal(results[2]?.file, undefined);
});

test("buildSarif produces a 2.1.0 log with driver and rules", () => {
  const log = buildSarif(secretFindingsToSarifResults([secretFinding()]));
  assert.equal(log.version, SARIF_VERSION);
  assert.equal(log.version, "2.1.0");
  assert.equal(log.runs[0]?.tool.driver.name, "oc-pilot");
  assert.equal(log.runs[0]?.tool.driver.version, VERSION);
  const ruleIds = log.runs[0]!.tool.driver.rules.map((rule) => rule.id);
  assert.deepEqual(ruleIds.sort(), [CRITICAL_RULE_ID, SECRET_RULE_ID, WARNING_RULE_ID].sort());
  const result = log.runs[0]!.results[0]!;
  assert.equal(result.locations?.[0]?.physicalLocation.artifactLocation.uri, "src/config.ts");
  assert.equal(result.locations?.[0]?.physicalLocation.region.startLine, 3);
});
