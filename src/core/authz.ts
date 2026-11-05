import { VERSION } from "../version.js";
import { SARIF_SCHEMA, SARIF_VERSION } from "./sarif.js";
import { stripComments } from "./sast.js";

export type AuthzSeverity = "high" | "medium";
export type AuthzRuleId = "route-no-auth" | "idor" | "admin-no-guard";

export interface AuthzFinding {
  rule: AuthzRuleId;
  severity: AuthzSeverity;
  file: string;
  line: number;
  column: number;
  method: string;
  route: string;
  message: string;
}

export interface AuthzRoute {
  file: string;
  line: number;
  method: string;
  route: string;
  public: boolean;
}

export interface AuthzReport {
  files: number;
  routes: AuthzRoute[];
  findings: AuthzFinding[];
  suppressed: number;
  summary: Record<AuthzSeverity, number>;
  baselineSuppressed?: number;
}

export interface AuthzScanResult {
  routes: AuthzRoute[];
  findings: AuthzFinding[];
  suppressed: number;
}

export interface AuthzScanOptions {
  /** Inline `oc-pilot:authz-ignore` comments are honoured by default. */
  suppressions?: boolean;
  /** Route prefixes that are public by design, e.g. `/health` or `/assets`. */
  publicRoutes?: string[];
}

const ROUTE_CALL =
  /\b(?:app|router|server|fastify|api)\.(get|post|put|patch|delete|all|use)\s*\(\s*["'`]([^"'`]+)["'`]/g;
const NEXT_METHOD =
  /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(|export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\s*=/g;

const AUTH =
  /\b(?:req|request|ctx)\.(?:user|session|auth)\b|\bres\.locals\.user\b|\b(?:getServerSession|getSession|currentUser|requireAuth|requireUser|ensureAuth|ensureLoggedIn|isAuthenticated|isLoggedIn|authMiddleware|authorize|checkPermission|verifyToken|verifyIdToken|verifyJwt|jwt\.verify|passport\.authenticate)\b|\bauth\s*\(/;
const REQUEST_ID = /\b(?:req|request)\.(?:params|body|query)\.(?:id|userId|accountId|orderId)\b/;
const LOOKUP =
  /\b(?:findById|findOne|findUnique|findFirst|getById|fetchById)\s*\(|\.where\s*\(\s*\{\s*id\b|\bWHERE\s+id\s*=/i;
const OWNERSHIP =
  /\b(?:req|request)\.user\.(?:id|sub)\b|\b(?:ownerId|tenantId|accountId|orgId|workspaceId|teamId)\b|\b(?:userId|createdBy|authorId)\s*===?\s*(?:req|request)\.user/;
const ROLE = /\b(?:role|roles|isAdmin|requireAdmin|checkPermission|permission|permissions|scope|scopes)\b/;
const ADMIN_PATH = /(?:^|\/)(?:admin|internal|manage|management)(?:\/|$)/i;
const DEFAULT_PUBLIC =
  /^\/(?:health|healthz|ready|live|metrics|ping|login|logout|signup|register|public|webhooks?|oauth|auth\/callback|favicon\.ico)(?:\/|$)/i;
const SUPPRESSION = /oc-pilot:authz-ignore(?:\s+([\w-]+))?\s*:\s*(\S.*)$/;

const SEVERITY_RANK: Record<AuthzSeverity, number> = { medium: 1, high: 2 };
const RULE_RANK: Record<AuthzRuleId, number> = { "route-no-auth": 0, idor: 1, "admin-no-guard": 2 };

export function severityAtLeast(value: AuthzSeverity, threshold: AuthzSeverity): boolean {
  return SEVERITY_RANK[value] >= SEVERITY_RANK[threshold];
}

export function parseAuthzSeverity(value: string): AuthzSeverity | undefined {
  return value === "high" || value === "medium" ? value : undefined;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function locate(starts: number[], offset: number): { line: number; column: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return { line: low + 1, column: offset - starts[low]! + 1 };
}

function suppressionAt(lines: string[], lineIndex: number, rule: string): boolean {
  for (const index of [lineIndex, lineIndex - 1]) {
    const line = lines[index];
    if (!line) continue;
    const match = line.match(SUPPRESSION);
    if (!match) continue;
    const scopedRule = match[1];
    const reason = match[2]?.trim() ?? "";
    if (reason.length < 3) continue;
    if (scopedRule && scopedRule !== rule) continue;
    return true;
  }
  return false;
}

function isPublic(route: string, options: AuthzScanOptions): boolean {
  if (DEFAULT_PUBLIC.test(route)) return true;
  return (options.publicRoutes ?? []).some((prefix) => prefix.length > 0 && route.startsWith(prefix));
}

function routeFromAppPath(file: string): string {
  const index = file.indexOf("app/");
  const rest = file
    .slice(index + 4)
    .replace(/\/?route\.(?:ts|js|tsx|jsx)$/, "");
  const segments = rest
    .split("/")
    .filter(Boolean)
    .filter((segment) => !/^\(.*\)$/.test(segment))
    .map((segment) => {
      if (segment.startsWith("[...")) return "*";
      if (segment.startsWith("[")) return `:${segment.replace(/^\[|\]$/g, "")}`;
      return segment;
    });
  return `/${segments.join("/")}`;
}

function routeFromPagesPath(file: string): string {
  const index = file.indexOf("pages/api/");
  let rest = file.slice(index + "pages/api/".length).replace(/\.(?:ts|js|tsx|jsx)$/, "");
  rest = rest.replace(/\/index$/, "").replace(/^index$/, "");
  const segments = rest
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      if (segment.startsWith("[...")) return "*";
      if (segment.startsWith("[")) return `:${segment.replace(/^\[|\]$/g, "")}`;
      return segment;
    });
  return `/api${segments.length > 0 ? `/${segments.join("/")}` : ""}`;
}

interface RawRoute {
  method: string;
  route: string;
  line: number;
  column: number;
  bodyStart: number;
  end: number;
}

/**
 * Finds route declarations and checks their handler scope for authentication,
 * ownership and role signals. This is an offline heuristic, not a data-flow
 * analysis: it is deliberately quiet when a handler is a bare reference.
 */
export function scanAuthzSource(file: string, text: string, options: AuthzScanOptions = {}): AuthzScanResult {
  const clean = stripComments(text);
  const starts = lineStarts(clean);
  const lines = text.split(/\r?\n/);
  const normalized = file.replace(/\\/g, "/");
  const raw: RawRoute[] = [];

  const isApp = /(?:^|\/)app\/.*route\.(?:ts|js|tsx|jsx)$/.test(normalized);
  const isPages = /(?:^|\/)pages\/api\/.*\.(?:ts|js|tsx|jsx)$/.test(normalized);

  if (isApp || isPages) {
    const route = isApp ? routeFromAppPath(normalized) : routeFromPagesPath(normalized);
    const methods = [...clean.matchAll(NEXT_METHOD)];
    for (let index = 0; index < methods.length; index += 1) {
      const match = methods[index]!;
      const method = match[1] ?? match[2] ?? "GET";
      const offset = match.index ?? 0;
      const { line, column } = locate(starts, offset);
      raw.push({
        method,
        route,
        line,
        column,
        bodyStart: offset,
        end: methods[index + 1]?.index ?? clean.length,
      });
    }
    if (methods.length === 0 && /export\s+default\b/.test(clean)) {
      const { line, column } = locate(starts, 0);
      raw.push({ method: "*", route, line, column, bodyStart: 0, end: clean.length });
    }
  } else {
    const matches = [...clean.matchAll(ROUTE_CALL)];
    for (let index = 0; index < matches.length; index += 1) {
      const match = matches[index]!;
      const method = (match[1] ?? "get").toUpperCase();
      if (method === "USE") continue;
      const offset = match.index ?? 0;
      const bodyStart = offset + match[0].length;
      // A handler passed by reference (`router.get("/x", controller.list)`) has
      // no body here, so authentication cannot be judged from this file.
      const head = clean.slice(bodyStart, bodyStart + 200);
      if (!/=>|function\b/.test(head)) continue;
      const { line, column } = locate(starts, offset);
      raw.push({
        method,
        route: match[2] ?? "/",
        line,
        column,
        bodyStart,
        end: matches[index + 1]?.index ?? Math.min(clean.length, offset + 4_000),
      });
    }
  }

  const routes: AuthzRoute[] = [];
  const findings: AuthzFinding[] = [];
  const seen = new Set<string>();
  let suppressed = 0;

  for (const route of raw) {
    const publicRoute = isPublic(route.route, options);
    routes.push({
      file,
      line: route.line,
      method: route.method,
      route: route.route,
      public: publicRoute,
    });

    const scope = clean.slice(route.bodyStart, route.end);
    const rules: Array<{ id: AuthzRuleId; severity: AuthzSeverity; hit: boolean; message: string }> = [
      {
        id: "route-no-auth",
        severity: "high",
        hit: !publicRoute && !AUTH.test(scope),
        message: "маршрут не проверяет аутентификацию — добавьте auth-middleware или проверку сессии",
      },
      {
        id: "idor",
        severity: "high",
        hit: REQUEST_ID.test(scope) && LOOKUP.test(scope) && !OWNERSHIP.test(scope),
        message: "объект ищется по идентификатору из запроса без проверки владельца или тенанта",
      },
      {
        id: "admin-no-guard",
        severity: "high",
        hit: ADMIN_PATH.test(route.route) && !ROLE.test(scope),
        message: "административный маршрут не проверяет роль или разрешение",
      },
    ];

    for (const rule of rules) {
      if (!rule.hit) continue;
      const key = `${rule.id}:${String(route.line)}:${String(route.column)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (options.suppressions !== false && suppressionAt(lines, route.line - 1, rule.id)) {
        suppressed += 1;
        continue;
      }
      findings.push({
        rule: rule.id,
        severity: rule.severity,
        file,
        line: route.line,
        column: route.column,
        method: route.method,
        route: route.route,
        message: rule.message,
      });
    }
  }

  findings.sort((a, b) => a.line - b.line || a.column - b.column || RULE_RANK[a.rule] - RULE_RANK[b.rule]);
  return { routes, findings, suppressed };
}

export function buildAuthzReport(files: number, results: AuthzScanResult[]): AuthzReport {
  const findings = results.flatMap((result) => result.findings);
  const summary: Record<AuthzSeverity, number> = { high: 0, medium: 0 };
  for (const finding of findings) summary[finding.severity] += 1;
  return {
    files,
    routes: results.flatMap((result) => result.routes),
    findings,
    suppressed: results.reduce((total, result) => total + result.suppressed, 0),
    summary,
  };
}

export function renderAuthz(report: AuthzReport): string {
  const lines = [
    `Файлов проверено: ${String(report.files)}.`,
    `Маршрутов найдено: ${String(report.routes.length)}.`,
    `Найдено: ${String(report.findings.length)} (high ${String(report.summary.high)}, medium ${String(report.summary.medium)}), подавлено: ${String(report.suppressed)}.`,
  ];
  if (report.findings.length === 0) {
    lines.push("Проблем не найдено.");
  } else {
    for (const finding of report.findings) {
      lines.push(
        `${finding.severity.toUpperCase().padEnd(6)} ${finding.rule.padEnd(16)} ${finding.method} ${finding.route} ${finding.file}:${String(finding.line)} — ${finding.message}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/** SARIF 2.1.0 for code scanning uploads. */
export function authzSarif(report: AuthzReport): string {
  const levels: Record<AuthzSeverity, "error" | "warning"> = { high: "error", medium: "warning" };
  const rules = [...new Set(report.findings.map((finding) => finding.rule))].map((id) => {
    const finding = report.findings.find((candidate) => candidate.rule === id)!;
    return {
      id: `oc-pilot/${id}`,
      name: id,
      shortDescription: { text: finding.message },
      defaultConfiguration: { level: levels[finding.severity] },
    };
  });
  const results = report.findings.map((finding) => ({
    ruleId: `oc-pilot/${finding.rule}`,
    level: levels[finding.severity],
    message: { text: `${finding.method} ${finding.route}: ${finding.message}` },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: finding.file.replace(/\\/g, "/") },
          region: { startLine: finding.line, startColumn: finding.column },
        },
      },
    ],
    properties: { severity: finding.severity, method: finding.method, route: finding.route },
  }));
  return `${JSON.stringify(
    {
      $schema: SARIF_SCHEMA,
      version: SARIF_VERSION,
      runs: [
        {
          tool: {
            driver: {
              name: "oc-pilot",
              informationUri: "https://github.com/oc-pilot/oc-pilot",
              version: VERSION,
              rules,
            },
          },
          results,
        },
      ],
    },
    null,
    2,
  )}\n`;
}
