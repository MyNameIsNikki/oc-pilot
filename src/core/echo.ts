import { existsSync } from "node:fs";
import { PilotError } from "./errors.js";
import { runGit } from "./git.js";
import { readReceipt, receiptPath, verifyReceipt } from "./receipt.js";
import { readStats, summarizeStats } from "./stats.js";

export interface EchoBadge {
  id: string;
  label: string;
  value: string;
  color: string;
}

export interface EchoStats {
  commits: number;
  runs: number;
  apiCalls: number;
  cacheHits: number;
  findings: number;
  testsPassed: boolean | null;
}

export interface EchoReport {
  name: string;
  sinceDays: number;
  generatedAt: string;
  stats: EchoStats;
  badges: EchoBadge[];
  content: string;
  submitted: boolean;
  endpoint?: string;
  submissionStatus?: string;
}

export type EchoFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface EchoOptions {
  name?: string;
  sinceDays?: number;
  submit?: boolean;
  endpoint?: string;
  fetchImpl?: EchoFetch;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function textWidth(value: string): number {
  return value.length * 7 + 14;
}

/** One self-contained SVG badge with a label and a value. */
export function renderBadgeSvg(badge: EchoBadge, y = 0): string {
  const labelWidth = textWidth(badge.label);
  const valueWidth = textWidth(String(badge.value));
  const width = labelWidth + valueWidth;
  return [
    `<g transform="translate(0 ${String(y)})">`,
    `<rect width="${String(width)}" height="20" rx="3" fill="#111827"/>`,
    `<rect width="${String(labelWidth)}" height="20" rx="3" fill="${badge.color}"/>`,
    `<text x="${String(labelWidth / 2)}" y="14" text-anchor="middle" font-family="monospace" font-size="11" fill="#ffffff">${escapeXml(badge.label)}</text>`,
    `<text x="${String(labelWidth + valueWidth / 2)}" y="14" text-anchor="middle" font-family="monospace" font-size="11" fill="#f9fafb">${escapeXml(String(badge.value))}</text>`,
    "</g>",
  ].join("");
}

/** A combined SVG sheet with every badge stacked vertically. */
export function renderEchoSvg(badges: readonly EchoBadge[], title: string): string {
  const width = Math.max(120, ...badges.map((badge) => textWidth(badge.label) + textWidth(String(badge.value))));
  const height = Math.max(24, badges.length * 26 + 8);
  const rows = badges.map((badge, index) => renderBadgeSvg(badge, 4 + index * 26)).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}" viewBox="0 0 ${String(width)} ${String(height)}" role="img" aria-label="${escapeXml(title)}"><title>${escapeXml(title)}</title>${rows}</svg>`;
}

function gitCommits(cwd: string, sinceDays: number): number {
  const result = runGit(["rev-list", "--count", `--since=${String(sinceDays)} days ago`, "HEAD"], cwd);
  if (result.status !== 0) return 0;
  const value = Number(result.stdout.trim());
  return Number.isFinite(value) ? value : 0;
}

function receiptTests(cwd: string): boolean | null {
  const path = receiptPath(cwd);
  if (!path || !existsSync(path)) return null;
  try {
    const receipt = readReceipt(path);
    const verification = verifyReceipt(cwd, receipt);
    if (!verification.ok || !receipt.tests) return null;
    return receipt.tests.passed;
  } catch {
    return null;
  }
}

async function submit(
  endpoint: string,
  payload: unknown,
  fetchImpl: EchoFetch,
): Promise<{ submitted: boolean; status: string }> {
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = (await response.text()).trim();
    return {
      submitted: response.ok,
      status: response.ok ? `ok ${String(response.status)}${text ? `: ${text.slice(0, 200)}` : ""}` : `http ${String(response.status)}`,
    };
  } catch (error) {
    return {
      submitted: false,
      status: `failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function buildEcho(cwd: string, options: EchoOptions = {}): Promise<EchoReport> {
  const sinceDays = Math.min(365, Math.max(1, options.sinceDays ?? 30));
  const name = (options.name ?? "anonymous").trim() || "anonymous";
  const sinceMs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  const summary = summarizeStats(readStats(cwd), sinceMs);
  const commits = gitCommits(cwd, sinceDays);
  const findings = summary.findings.critical + summary.findings.warning + summary.findings.style;
  const testsPassed = receiptTests(cwd);
  const stats: EchoStats = {
    commits,
    runs: summary.runs,
    apiCalls: summary.apiCalls,
    cacheHits: summary.cacheHits,
    findings,
    testsPassed,
  };
  const badges: EchoBadge[] = [
    { id: "commits", label: "commits", value: String(commits), color: "#2563eb" },
    { id: "runs", label: "agent runs", value: String(summary.runs), color: "#7c3aed" },
    { id: "api", label: "API calls", value: String(summary.apiCalls), color: "#0891b2" },
    { id: "cache", label: "cache hits", value: String(summary.cacheHits), color: "#16a34a" },
    {
      id: "findings",
      label: "findings",
      value: String(findings),
      color: findings > 0 ? "#dc2626" : "#16a34a",
    },
    {
      id: "tests",
      label: "tests",
      value: testsPassed === null ? "unknown" : testsPassed ? "pass" : "fail",
      color: testsPassed === null ? "#6b7280" : testsPassed ? "#16a34a" : "#dc2626",
    },
  ];
  const generatedAt = new Date().toISOString();
  const payload = { name, sinceDays, generatedAt, stats };
  const report: EchoReport = {
    name,
    sinceDays,
    generatedAt,
    stats,
    badges,
    content: renderEchoSvg(badges, `${name}: ${String(sinceDays)} days with oc-pilot`),
    submitted: false,
  };

  if (options.submit) {
    if (!options.endpoint) {
      throw new PilotError("Для отправки нужен --endpoint", {
        hint: "Укажите URL лидерборда: --submit --endpoint https://example.com/echo.",
        exitCode: 2,
      });
    }
    const endpoint = options.endpoint;
    const fetchImpl: EchoFetch =
      options.fetchImpl ??
      (async (url, init) => {
        const response = await fetch(url, init);
        return { ok: response.ok, status: response.status, text: () => response.text() };
      });
    const result = await submit(endpoint, payload, fetchImpl);
    report.endpoint = endpoint;
    report.submitted = result.submitted;
    report.submissionStatus = result.status;
  }

  return report;
}

export function describeEcho(report: EchoReport): string {
  const stats = report.stats;
  const tests = stats.testsPassed === null ? "нет квитанции" : stats.testsPassed ? "пройдены" : "провалены";
  const submission = report.submitted ? "отправлено" : report.submissionStatus ? "не отправлено" : "локально";
  return `Эхо ${report.name}: ${String(stats.commits)} коммитов, ${String(stats.runs)} запусков, ${String(stats.apiCalls)} вызовов API, тесты ${tests} (${submission}).`;
}
