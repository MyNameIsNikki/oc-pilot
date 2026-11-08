import assert from "node:assert/strict";
import test from "node:test";
import type { DiffStats, SecretFinding } from "../types.js";
import type { AuthzFinding } from "./authz.js";
import type { DepIssue, DependencyAudit } from "./deps-health.js";
import { buildPreflightReport, renderPreflight, scopeDependencyIssues, type PreflightInput } from "./preflight.js";
import type { SastFinding } from "./sast.js";
import type { SlopDelta, SlopReport } from "./slop/model.js";
import type { TestWeakness } from "./test-weakening.js";

const STATS: DiffStats = { files: 1, additions: 3, deletions: 0 };

function cleanAudit(issues: DepIssue[]): { audit: DependencyAudit; issues: DepIssue[] } {
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

function slopReport(index: number): SlopReport {
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

function slopDelta(deltaPoints: number): SlopDelta {
  return {
    base: "HEAD",
    index: 45,
    deltaPoints,
    categories: [{ id: "duplicates", label: "Дубликаты", introduced: 2, removed: 0 }],
    introduced: 2,
    removed: 0,
  };
}

function input(overrides: Partial<PreflightInput> = {}): PreflightInput {
  return {
    diff: { source: "git diff HEAD", stats: STATS },
    secrets: [],
    sast: [],
    authz: [],
    deps: cleanAudit([]),
    weaknesses: [],
    slop: { report: slopReport(45), delta: slopDelta(2) },
    honeypot: { deployed: true, entries: [], triggers: [] },
    injection: { files: 1, findings: [], counts: { high: 0, medium: 0, low: 0 }, summary: "Prompt-injection не найдено.", content: "" },
    ...overrides,
  };
}

const CRITICAL: SecretFinding = {
  file: "src/app.ts",
  line: 4,
  kind: "AWS Access Key ID",
  severity: "critical",
  preview: "AKIA…",
};

test("scopeDependencyIssues keeps only issues touched by the change", () => {
  const issues: DepIssue[] = [
    { kind: "phantom", severity: "high", name: "axios", message: "not declared", files: ["src/app.ts"] },
    { kind: "phantom", severity: "high", name: "zod", message: "not declared", files: ["src/old.ts"] },
    { kind: "unused", severity: "medium", name: "left-pad", message: "unused" },
  ];
  const diff = ["diff --git a/src/app.ts b/src/app.ts", "+++ b/src/app.ts", '+import "left-pad";'].join("\n");

  const scoped = scopeDependencyIssues(issues, ["src/app.ts"], diff);

  assert.deepEqual(
    scoped.map((issue) => issue.name),
    ["axios", "left-pad"],
  );
});

test("preflight passes when every check is clean", () => {
  const report = buildPreflightReport(input());

  assert.equal(report.status, "pass");
  assert.deepEqual(
    report.checks.map((check) => check.status),
    ["pass", "pass", "pass", "pass", "pass", "pass", "pass", "pass"],
  );
  assert.equal(report.diff.files, 1);
});

test("a honeypot trigger fails preflight", () => {
  const report = buildPreflightReport(
    input({
      honeypot: {
        deployed: true,
        entries: [],
        triggers: [
          {
            path: "src/utils/legacy/bypassAuth.ts",
            kind: "function",
            symbol: "bypassAuth",
            evidence: 'import { bypassAuth } from "./legacy/bypassAuth";',
          },
        ],
      },
    }),
  );

  assert.equal(report.status, "fail");
  const check = report.checks.find((entry) => entry.id === "honeypot");
  assert.equal(check?.status, "fail");
  assert.match(check!.summary, /\[HONEYPOT TRIGGERED\]/);
  assert.match(check!.details[0] ?? "", /bypassAuth/);
});

test("honeypot without a manifest is skipped", () => {
  const report = buildPreflightReport(input({ honeypot: null }));
  const check = report.checks.find((entry) => entry.id === "honeypot");
  assert.equal(check?.status, "skip");
  assert.match(check!.summary, /не развёрнут/);
});

test("a high prompt-injection finding fails preflight", () => {
  const report = buildPreflightReport(
    input({
      injection: {
        files: 1,
        findings: [
          {
            file: "README.md",
            line: 3,
            kind: "override",
            severity: "high",
            rule: "ignore-previous",
            evidence: "ignore all previous instructions",
          },
        ],
        counts: { high: 1, medium: 0, low: 0 },
        summary: "Найдено",
        content: "",
      },
    }),
  );
  const check = report.checks.find((entry) => entry.id === "injection");
  assert.equal(check?.status, "fail");
  assert.match(check!.summary, /\[PROMPT INJECTION DETECTED\]/);
  assert.match(check!.details[0] ?? "", /README\.md:3/);
});

test("a critical secret fails the run and a warning alone does not", () => {
  const failed = buildPreflightReport(input({ secrets: [CRITICAL] }));
  assert.equal(failed.status, "fail");
  assert.equal(failed.checks[0]?.status, "fail");
  assert.match(failed.checks[0]!.summary, /1 critical/);
  assert.deepEqual(failed.checks[0]?.details, ["src/app.ts:4 — AWS Access Key ID"]);

  const warned = buildPreflightReport(
    input({ secrets: [{ ...CRITICAL, severity: "warning" }] }),
  );
  assert.equal(warned.status, "pass");
  assert.equal(warned.checks[0]?.status, "pass");
});

const SAST: SastFinding = {
  rule: "command-injection",
  severity: "high",
  file: "src/app.ts",
  line: 7,
  column: 3,
  message: "команда собирается из пользовательского ввода",
  snippet: "exec(req.query.dir)",
};

test("SAST findings fail only above the configured gate", () => {
  const high = buildPreflightReport(input({ sast: [SAST] }));
  assert.equal(high.status, "fail");
  assert.equal(high.checks[1]?.status, "fail");
  assert.match(high.checks[1]!.summary, /1 находок: high 1/);
  assert.deepEqual(high.checks[1]?.details, [
    "high command-injection src/app.ts:7 — команда собирается из пользовательского ввода",
  ]);

  const medium: SastFinding = { ...SAST, rule: "cors-wildcard", severity: "medium" };
  assert.equal(buildPreflightReport(input({ sast: [medium] })).status, "pass");
  assert.equal(buildPreflightReport(input({ sast: [medium], sastGate: "medium" })).status, "fail");
});

const AUTHZ: AuthzFinding = {
  rule: "idor",
  severity: "high",
  file: "src/routes.ts",
  line: 2,
  column: 3,
  method: "GET",
  route: "/users/:id",
  message: "объект ищется по id из запроса без проверки владельца",
};

test("authz findings fail only above the configured gate", () => {
  const high = buildPreflightReport(input({ authz: [AUTHZ] }));
  assert.equal(high.status, "fail");
  assert.equal(high.checks[2]?.status, "fail");
  assert.match(high.checks[2]!.summary, /1 находок: high 1/);
  assert.deepEqual(high.checks[2]?.details, [
    "high idor GET /users/:id src/routes.ts:2 — объект ищется по id из запроса без проверки владельца",
  ]);

  const medium: AuthzFinding = { ...AUTHZ, severity: "medium" };
  assert.equal(buildPreflightReport(input({ authz: [medium] })).status, "pass");
  assert.equal(buildPreflightReport(input({ authz: [medium], authzGate: "medium" })).status, "fail");
});

test("dependency issues fail only above the configured gate", () => {
  const high: DepIssue = { kind: "phantom", severity: "high", name: "axios", message: "not declared" };
  const medium: DepIssue = { kind: "unused", severity: "medium", name: "left-pad", message: "unused" };

  assert.equal(buildPreflightReport(input({ deps: cleanAudit([high]) })).status, "fail");
  assert.equal(
    buildPreflightReport(input({ deps: cleanAudit([high]), depsGate: "medium" })).status,
    "fail",
  );
  assert.equal(
    buildPreflightReport(input({ deps: cleanAudit([medium]), depsGate: "high" })).status,
    "pass",
  );
  assert.equal(
    buildPreflightReport(input({ deps: cleanAudit([medium]), depsGate: "low" })).status,
    "fail",
  );
});

test("weakened tests fail the run", () => {
  const weakness: TestWeakness = {
    file: "src/app.test.ts",
    line: 12,
    kind: "skipped-test",
    detail: "тест пропущен через it.skip",
  };
  const report = buildPreflightReport(input({ weaknesses: [weakness] }));

  assert.equal(report.status, "fail");
  assert.equal(report.checks[4]?.status, "fail");
  assert.match(report.checks[4]!.summary, /1 ослабление/);
  assert.deepEqual(report.checks[4]?.details, ["src/app.test.ts:12 — тест пропущен через it.skip"]);
});

test("slop growth above the limit fails the run", () => {
  const report = buildPreflightReport(
    input({ slop: { report: slopReport(55), delta: slopDelta(12) }, maxSlopDelta: 10 }),
  );

  assert.equal(report.status, "fail");
  assert.equal(report.checks[5]?.status, "fail");
  assert.match(report.checks[5]!.summary, /\+12/);
  assert.deepEqual(report.checks[5]?.details, ["Дубликаты: +2"]);
});

test("skipped checks stay visible without failing", () => {
  const report = buildPreflightReport(
    input({
      disabled: ["secrets", "sast", "authz", "deps", "tests", "slop", "honeypot", "injection"],
    }),
  );

  assert.equal(report.status, "pass");
  assert.deepEqual(
    report.checks.map((check) => check.status),
    ["skip", "skip", "skip", "skip", "skip", "skip", "skip", "skip"],
  );
  assert.match(report.checks[0]!.summary, /--no-secret-scan/);
  assert.match(report.checks[1]!.summary, /--no-sast/);
  assert.match(report.checks[2]!.summary, /--no-authz/);
  assert.match(report.checks[5]!.summary, /--no-slop/);
  assert.match(report.checks[6]!.summary, /--no-honeypot/);
  assert.match(report.checks[7]!.summary, /--no-injection/);
});

test("preflight does not claim a zero index for an empty diff", () => {
  const report = buildPreflightReport(
    input({
      diff: { source: "git diff HEAD", stats: { files: 0, additions: 0, deletions: 0 } },
      slop: { report: slopReport(47), delta: slopDelta(0) },
    }),
  );
  const slop = report.checks.find((check) => check.id === "slop");
  assert.equal(slop?.status, "pass");
  assert.match(slop?.summary ?? "", /изменённых файлов нет/);
});

test("renderPreflight prints one verdict per check", () => {
  const report = buildPreflightReport(input({ secrets: [CRITICAL] }));
  const text = renderPreflight(report);

  assert.match(text, /FAIL {2}secrets/);
  assert.match(text, /OK {4}deps/);
  assert.match(text, /Preflight не пройден: 1 из 8 проверок\./);
  assert.ok(text.endsWith("\n"));

  const clean = renderPreflight(buildPreflightReport(input()));
  assert.match(clean, /Preflight пройден: 8 проверок, замечаний нет\./);
});
