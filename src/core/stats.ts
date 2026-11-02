/**
 * Usage stats: an append-only JSONL journal under .git/oc-pilot/stats.jsonl.
 * Powers `oc-pilot stats`, daily API-call budgets and `oc-pilot day`. Stats
 * never leave the machine and never fail a review.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { getRepoRoot, isGitRepo, runGit } from "./git.js";

export interface ApiCallRecord {
  ts: number;
  model: string | null;
  cached: boolean;
  durationMs: number;
}

export interface RunRecord {
  ts: number;
  recipe: string;
  engine: string;
  exitCode: number;
  findings: { critical: number; warning: number; style: number };
}

export interface StatsRecords {
  apiCalls: ApiCallRecord[];
  runs: RunRecord[];
}

function statsRoot(cwd: string): string | undefined {
  if (!isGitRepo(cwd)) return undefined;
  const repoRoot = getRepoRoot(cwd);
  const gitDir = runGit(["rev-parse", "--git-dir"], repoRoot);
  if (gitDir.status !== 0) return undefined;
  const raw = gitDir.stdout.trim();
  const resolved = /^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(raw) ? raw : join(repoRoot, raw);
  return join(resolved, "oc-pilot");
}

function statsPath(cwd: string): string | undefined {
  const root = statsRoot(cwd);
  return root ? join(root, "stats.jsonl") : undefined;
}

function appendStatsLine(cwd: string, record: unknown): void {
  const path = statsPath(cwd);
  if (!path) return;
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Stats must never break a review.
  }
}

export function recordApiCall(cwd: string, call: { model?: string; cached: boolean; durationMs: number }): void {
  appendStatsLine(cwd, { type: "api", ts: Date.now(), model: call.model?.trim() || null, cached: call.cached, durationMs: Math.round(call.durationMs) } satisfies ApiCallRecord & { type: string });
}

export function recordRun(
  cwd: string,
  run: { recipe: string; engine: string; exitCode: number; findings: { critical: number; warning: number; style: number } },
): void {
  appendStatsLine(cwd, { type: "run", ts: Date.now(), ...run } satisfies RunRecord & { type: string });
}

export function readStats(cwd: string): StatsRecords {
  const path = statsPath(cwd);
  const records: StatsRecords = { apiCalls: [], runs: [] };
  if (!path || !existsSync(path)) return records;
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { type?: string };
        if (parsed.type === "api") records.apiCalls.push(parsed as ApiCallRecord);
        if (parsed.type === "run") records.runs.push(parsed as RunRecord);
      } catch {
        // Skip a damaged line.
      }
    }
  } catch {
    // Unreadable stats behave like empty stats.
  }
  return records;
}

export function clearStats(cwd: string): boolean {
  const path = statsPath(cwd);
  if (!path || !existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/** Start of the current local day in ms. */
export function todayStartMs(now: number = Date.now()): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Uncached API calls since the given timestamp (what budgets count). */
export function countApiCallsSince(records: StatsRecords, sinceMs: number): number {
  return records.apiCalls.filter((call) => !call.cached && call.ts >= sinceMs).length;
}

export interface StatsSummary {
  runs: number;
  apiCalls: number;
  cacheHits: number;
  savedApiCalls: number;
  avgDurationMs: number;
  findings: { critical: number; warning: number; style: number };
}

export function summarizeStats(records: StatsRecords, sinceMs: number): StatsSummary {
  const runs = records.runs.filter((run) => run.ts >= sinceMs);
  const calls = records.apiCalls.filter((call) => call.ts >= sinceMs);
  const cacheHits = calls.filter((call) => call.cached).length;
  const durations = calls.filter((call) => !call.cached).map((call) => call.durationMs);
  const findings = { critical: 0, warning: 0, style: 0 };
  for (const run of runs) {
    findings.critical += run.findings?.critical ?? 0;
    findings.warning += run.findings?.warning ?? 0;
    findings.style += run.findings?.style ?? 0;
  }
  return {
    runs: runs.length,
    apiCalls: calls.length,
    cacheHits,
    savedApiCalls: cacheHits,
    avgDurationMs: durations.length > 0 ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0,
    findings,
  };
}
