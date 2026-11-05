import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSastReport,
  parseSastSeverity,
  renderSast,
  sastSarif,
  scanSource,
  severityAtLeast,
  stripComments,
} from "./sast.js";

test("scanSource reports request data reaching dangerous sinks", () => {
  const source = [
    'const { exec } = require("node:child_process");',
    "exec(`rm -rf ${req.query.dir}`);",
    'db.query("SELECT * FROM users WHERE id = " + req.query.id);',
    "readFile(req.query.file);",
    "fetch(req.body.url);",
    "eval(userInput);",
    "el.innerHTML = req.query.html;",
    "https.request({ rejectUnauthorized: false });",
    "",
  ].join("\n");

  const { findings, suppressed } = scanSource("src/app.js", source);
  const rules = findings.map((finding) => finding.rule).sort();
  assert.deepEqual(rules, [
    "code-injection",
    "command-injection",
    "path-traversal",
    "sql-injection",
    "ssrf",
    "tls-verification",
    "xss",
  ]);
  assert.equal(suppressed, 0);
  assert.equal(findings.find((finding) => finding.rule === "sql-injection")?.line, 3);
  assert.match(findings.find((finding) => finding.rule === "command-injection")?.snippet ?? "", /exec/);
});

test("constant arguments do not trigger the taint rules", () => {
  const source = [
    'exec("ls -la");',
    'db.query("SELECT 1");',
    'readFile("/etc/hosts");',
    'fetch("https://example.com");',
    'el.innerHTML = "<b>static</b>";',
    "",
  ].join("\n");

  const { findings } = scanSource("src/safe.js", source);
  assert.deepEqual(findings, []);
});

test("path.resolve silences the path-traversal rule", () => {
  const source = 'readFile(path.resolve("/data", req.query.file));\n';
  const { findings } = scanSource("src/files.js", source);
  assert.deepEqual(findings, []);
});

test("stripComments removes comments but keeps string contents and offsets", () => {
  const source = [
    "// exec(req.query.x)",
    "/* db.query(req.body.y) */",
    'const value = "exec(req.query.z)";',
    "",
  ].join("\n");
  const clean = stripComments(source);
  assert.equal(clean.includes("exec(req.query.x)"), false);
  assert.equal(clean.includes("db.query(req.body.y)"), false);
  assert.equal(clean.includes("exec(req.query.z)"), true);
  assert.equal(clean.split("\n").length, source.split("\n").length);
  assert.equal(clean.length, source.length);
});

test("inline suppressions need a reason and may be scoped to a rule", () => {
  const suppressed = scanSource(
    "src/admin.js",
    "exec(req.query.cmd); // oc-pilot:sast-ignore command-injection: trusted admin command\n",
  );
  assert.deepEqual(suppressed.findings, []);
  assert.equal(suppressed.suppressed, 1);

  const noReason = scanSource("src/admin.js", "exec(req.query.cmd); // oc-pilot:sast-ignore\n");
  assert.equal(noReason.findings.length, 1);

  const wrongRule = scanSource(
    "src/admin.js",
    "exec(req.query.cmd); // oc-pilot:sast-ignore sql-injection: wrong rule\n",
  );
  assert.equal(wrongRule.findings.length, 1);
});

test("severity helpers order the levels", () => {
  assert.equal(parseSastSeverity(" HIGH "), "high");
  assert.equal(parseSastSeverity("critical"), undefined);
  assert.equal(severityAtLeast("high", "medium"), true);
  assert.equal(severityAtLeast("medium", "high"), false);
  assert.equal(severityAtLeast("low", "low"), true);
});

test("buildSastReport and renderSast summarize the scan", () => {
  const high = scanSource("src/a.js", "exec(req.query.cmd);\n");
  const medium = scanSource("src/b.js", "res.redirect(req.query.next);\n");
  const report = buildSastReport(2, [high, medium]);

  assert.equal(report.files, 2);
  assert.equal(report.findings.length, 2);
  assert.deepEqual(report.summary, { high: 1, medium: 1, low: 0 });

  const text = renderSast(report);
  assert.match(text, /Файлов проверено: 2\./);
  assert.match(text, /Найдено: 2 \(high 1, medium 1, low 0\), подавлено: 0\./);
  assert.match(text, /HIGH\s+command-injection\s+src\/a\.js:1/);
  assert.equal(text.endsWith("\n"), true);

  const empty = renderSast(buildSastReport(1, [scanSource("src/safe.js", "const a = 1;\n")]));
  assert.match(empty, /Проблем не найдено\./);
});

test("sastSarif emits SARIF 2.1.0 with rule metadata", () => {
  const report = buildSastReport(1, [scanSource("src/a.js", 'db.query("SELECT " + req.query.id);\n')]);
  const sarif = JSON.parse(sastSarif(report)) as {
    version: string;
    runs: Array<{
      tool: { driver: { name: string; rules: Array<{ id: string }> } };
      results: Array<{
        ruleId: string;
        level: string;
        locations: Array<{ physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number } } }>;
        properties: { severity: string };
      }>;
    }>;
  };

  assert.equal(sarif.version, "2.1.0");
  assert.equal(sarif.runs[0]?.tool.driver.name, "oc-pilot");
  assert.deepEqual(sarif.runs[0]?.tool.driver.rules.map((rule) => rule.id), ["oc-pilot/sql-injection"]);
  assert.equal(sarif.runs[0]?.results[0]?.ruleId, "oc-pilot/sql-injection");
  assert.equal(sarif.runs[0]?.results[0]?.level, "error");
  assert.equal(sarif.runs[0]?.results[0]?.locations[0]?.physicalLocation.artifactLocation.uri, "src/a.js");
  assert.equal(sarif.runs[0]?.results[0]?.locations[0]?.physicalLocation.region.startLine, 1);
  assert.equal(sarif.runs[0]?.results[0]?.properties.severity, "high");
});
