import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authzSarif,
  buildAuthzReport,
  parseAuthzSeverity,
  renderAuthz,
  scanAuthzSource,
  severityAtLeast,
} from "./authz.js";

const EXPRESS = [
  'const express = require("express");',
  "const router = express.Router();",
  'router.get("/users/:id", async (req, res) => {',
  "  const user = await db.user.findUnique({ where: { id: req.params.id } });",
  "  res.json(user);",
  "});",
  'router.get("/me", async (req, res) => {',
  "  const user = await db.user.findUnique({ where: { id: req.user.id } });",
  "  res.json(user);",
  "});",
  "",
].join("\n");

test("scanAuthzSource flags a route without auth and an IDOR lookup", () => {
  const result = scanAuthzSource("src/routes.ts", EXPRESS);
  assert.equal(result.routes.length, 2);
  assert.equal(result.routes[0]?.route, "/users/:id");
  assert.equal(result.routes[0]?.method, "GET");
  assert.deepEqual(
    result.findings.map((finding) => [finding.route, finding.rule]),
    [
      ["/users/:id", "route-no-auth"],
      ["/users/:id", "idor"],
    ],
  );
  assert.equal(result.findings[0]?.line, 3);
});

test("scanAuthzSource keeps authenticated ownership checks quiet", () => {
  const source = [
    'router.get("/orders/:id", async (req, res) => {',
    "  if (!req.user) return res.status(401).end();",
    "  const order = await db.order.findUnique({ where: { id: req.params.id } });",
    "  res.json(order);",
    "});",
    "",
  ].join("\n");
  const result = scanAuthzSource("src/orders.ts", source);
  assert.deepEqual(
    result.findings.map((finding) => finding.rule),
    ["idor"],
  );

  const scoped = source.replace(
    "where: { id: req.params.id }",
    "where: { id: req.params.id, tenantId: req.user.tenantId }",
  );
  assert.deepEqual(scanAuthzSource("src/orders.ts", scoped).findings, []);
});

test("scanAuthzSource guards admin routes with a role check", () => {
  const open = [
    'router.post("/admin/users", async (req, res) => {',
    "  await db.user.create({ data: req.body });",
    "  res.status(201).end();",
    "});",
    "",
  ].join("\n");
  assert.deepEqual(
    scanAuthzSource("src/admin.ts", open).findings.map((finding) => finding.rule),
    ["route-no-auth", "admin-no-guard"],
  );

  const guarded = open.replace(
    "await db.user.create",
    'if (req.user.role !== "admin") return res.status(403).end();\n  await db.user.create',
  );
  assert.deepEqual(scanAuthzSource("src/admin.ts", guarded).findings, []);
});

test("scanAuthzSource skips public routes and handlers passed by reference", () => {
  const publicRoute = 'router.get("/health", async (req, res) => res.json({ ok: true }));\n';
  const result = scanAuthzSource("src/app.ts", publicRoute);
  assert.equal(result.routes[0]?.public, true);
  assert.deepEqual(result.findings, []);

  const prefixed = scanAuthzSource("src/app.ts", 'router.get("/assets/logo", async () => 1);\n', {
    publicRoutes: ["/assets"],
  });
  assert.deepEqual(prefixed.findings, []);

  const reference = scanAuthzSource("src/app.ts", 'router.get("/users", controller.list);\n');
  assert.deepEqual(reference.routes, []);
});

test("scanAuthzSource ignores route examples in comments after a regex literal", () => {
  const source = [
    "const quotes = /[\"'`]/;",
    '// router.get("/users/:id", (req, res) => res.send("x"));',
    "export const ok = 1;",
    "",
  ].join("\n");
  const report = scanAuthzSource("src/app.ts", source);
  assert.deepEqual(report.findings, []);
});

test("scanAuthzSource understands Next.js app routes", () => {
  const source = [
    "export async function GET(req: Request) {",
    "  const user = await db.user.findUnique({ where: { id: req.params.id } });",
    "  return Response.json(user);",
    "}",
    "",
  ].join("\n");
  const result = scanAuthzSource("app/users/[id]/route.ts", source);
  assert.equal(result.routes[0]?.route, "/users/:id");
  assert.equal(result.routes[0]?.method, "GET");
  assert.deepEqual(
    result.findings.map((finding) => finding.rule),
    ["route-no-auth", "idor"],
  );
});

test("scanAuthzSource honours suppressions only with a reason", () => {
  const source = [
    "// oc-pilot:authz-ignore idor: доступ ограничен на уровне шлюза",
    'router.get("/x/:id", async (req, res) => {',
    "  const item = await db.item.findById(req.params.id);",
    "  res.json(item);",
    "});",
    "",
  ].join("\n");
  const result = scanAuthzSource("src/x.ts", source);
  assert.equal(result.suppressed, 1);
  assert.deepEqual(
    result.findings.map((finding) => finding.rule),
    ["route-no-auth"],
  );

  const withoutReason = source.replace(": доступ ограничен на уровне шлюза", ":");
  assert.equal(scanAuthzSource("src/x.ts", withoutReason).suppressed, 0);
});

test("report, render and SARIF describe the findings", () => {
  const result = scanAuthzSource("src/routes.ts", EXPRESS);
  const report = buildAuthzReport(1, [result]);
  assert.equal(report.summary.high, 2);
  assert.equal(report.routes.length, 2);

  const text = renderAuthz(report);
  assert.match(text, /Маршрутов найдено: 2/);
  assert.match(text, /HIGH\s+route-no-auth/);
  assert.match(text, /GET \/users\/:id src\/routes\.ts:3/);
  assert.ok(text.endsWith("\n"));

  const sarif = JSON.parse(authzSarif(report)) as {
    version: string;
    runs: Array<{ results: Array<{ ruleId: string; level: string }> }>;
  };
  assert.equal(sarif.version, "2.1.0");
  assert.equal(sarif.runs[0]?.results[0]?.ruleId, "oc-pilot/route-no-auth");
  assert.equal(sarif.runs[0]?.results[0]?.level, "error");
});

test("severity helpers accept only high and medium", () => {
  assert.equal(parseAuthzSeverity("high"), "high");
  assert.equal(parseAuthzSeverity("low"), undefined);
  assert.equal(severityAtLeast("high", "medium"), true);
  assert.equal(severityAtLeast("medium", "high"), false);
});
