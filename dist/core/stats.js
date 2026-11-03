/**
 * Usage stats: an append-only JSONL journal under .git/oc-pilot/stats.jsonl.
 * Powers `oc-pilot stats`, daily API-call budgets and `oc-pilot day`. Stats
 * never leave the machine and never fail a review.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { getRepoRoot, isGitRepo, runGit } from "./git.js";
function statsRoot(cwd) {
    if (!isGitRepo(cwd))
        return undefined;
    const repoRoot = getRepoRoot(cwd);
    const gitDir = runGit(["rev-parse", "--git-dir"], repoRoot);
    if (gitDir.status !== 0)
        return undefined;
    const raw = gitDir.stdout.trim();
    const resolved = /^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(raw) ? raw : join(repoRoot, raw);
    return join(resolved, "oc-pilot");
}
function statsPath(cwd) {
    const root = statsRoot(cwd);
    return root ? join(root, "stats.jsonl") : undefined;
}
function appendStatsLine(cwd, record) {
    const path = statsPath(cwd);
    if (!path)
        return;
    try {
        mkdirSync(join(path, ".."), { recursive: true });
        appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
    }
    catch {
        // Stats must never break a review.
    }
}
export function recordApiCall(cwd, call) {
    appendStatsLine(cwd, {
        type: "api",
        ts: Date.now(),
        model: call.model?.trim() || null,
        cached: call.cached,
        durationMs: Math.round(call.durationMs),
        ...(call.costUsd !== undefined ? { costUsd: call.costUsd } : {}),
    });
}
export function recordRun(cwd, run) {
    appendStatsLine(cwd, { type: "run", ts: Date.now(), ...run });
}
export function readStats(cwd) {
    const path = statsPath(cwd);
    const records = { apiCalls: [], runs: [] };
    if (!path || !existsSync(path))
        return records;
    try {
        for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
            if (!line.trim())
                continue;
            try {
                const parsed = JSON.parse(line);
                if (parsed.type === "api")
                    records.apiCalls.push(parsed);
                if (parsed.type === "run")
                    records.runs.push(parsed);
            }
            catch {
                // Skip a damaged line.
            }
        }
    }
    catch {
        // Unreadable stats behave like empty stats.
    }
    return records;
}
export function clearStats(cwd) {
    const path = statsPath(cwd);
    if (!path || !existsSync(path))
        return false;
    rmSync(path, { force: true });
    return true;
}
/** Start of the current local day in ms. */
export function todayStartMs(now = Date.now()) {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
}
/** Uncached API calls since the given timestamp (what budgets count). */
export function countApiCallsSince(records, sinceMs) {
    return records.apiCalls.filter((call) => !call.cached && call.ts >= sinceMs).length;
}
/** Estimated spend since the given timestamp, in USD. */
export function sumCostSince(records, sinceMs) {
    const total = records.apiCalls
        .filter((call) => call.ts >= sinceMs)
        .reduce((sum, call) => sum + (call.costUsd ?? 0), 0);
    return Math.round(total * 1_000_000) / 1_000_000;
}
export function summarizeStats(records, sinceMs) {
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
//# sourceMappingURL=stats.js.map