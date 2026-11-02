import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeBaseUrl, runOpenAiCompatible } from "./engine.js";
import { PilotError } from "./errors.js";
import { getRepoRoot, isGitRepo, runGit } from "./git.js";
import { log } from "./log.js";
import { countApiCallsSince, readStats, recordApiCall, todayStartMs } from "./stats.js";
export const DEFAULT_CACHE_TTL_SECONDS = 86_400;
const CACHE_VERSION = 1;
function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
/** Cache key: any change to the prompt, model or endpoint invalidates the entry. */
export function cacheKey(options) {
    return sha256(JSON.stringify({
        model: options.model?.trim() ?? "",
        baseUrl: normalizeBaseUrl(options.baseUrl),
        systemPrompt: options.systemPrompt,
        input: options.input,
    }));
}
/** Cache lives inside .git so it never pollutes the working tree. */
export function cacheRoot(cwd) {
    if (!isGitRepo(cwd))
        return undefined;
    const repoRoot = getRepoRoot(cwd);
    const gitDir = runGit(["rev-parse", "--git-dir"], repoRoot);
    if (gitDir.status !== 0)
        return undefined;
    const raw = gitDir.stdout.trim();
    const resolved = /^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(raw) ? raw : join(repoRoot, raw);
    return join(resolved, "oc-pilot", "cache");
}
function entryPath(root, key) {
    return join(root, `${key}.json`);
}
function readEntry(root, key, now) {
    const path = entryPath(root, key);
    if (!existsSync(path))
        return undefined;
    try {
        const entry = JSON.parse(readFileSync(path, "utf8"));
        if (entry.version !== CACHE_VERSION || typeof entry.text !== "string") {
            rmSync(path, { force: true });
            return undefined;
        }
        if (now >= entry.expiresAt) {
            rmSync(path, { force: true });
            return undefined;
        }
        return entry.text;
    }
    catch {
        rmSync(path, { force: true });
        return undefined;
    }
}
function writeEntry(root, key, text, ttlSeconds, now) {
    try {
        mkdirSync(root, { recursive: true });
        const entry = {
            version: CACHE_VERSION,
            createdAt: now,
            expiresAt: now + ttlSeconds * 1000,
            text,
        };
        writeFileSync(entryPath(root, key), JSON.stringify(entry), "utf8");
    }
    catch {
        // A read-only or missing .git directory must never fail a review.
    }
}
export function cacheStats(cwd) {
    const root = cacheRoot(cwd);
    if (!root || !existsSync(root))
        return undefined;
    const now = Date.now();
    const stats = { entries: 0, bytes: 0, expired: 0 };
    for (const name of readdirSync(root)) {
        if (!name.endsWith(".json"))
            continue;
        const path = join(root, name);
        try {
            const entry = JSON.parse(readFileSync(path, "utf8"));
            stats.entries += 1;
            stats.bytes += Buffer.byteLength(readFileSync(path));
            if (now >= entry.expiresAt)
                stats.expired += 1;
        }
        catch {
            stats.expired += 1;
        }
    }
    return stats;
}
/** Removes expired entries; returns the number of deleted files. */
export function pruneCache(cwd) {
    const root = cacheRoot(cwd);
    if (!root || !existsSync(root))
        return 0;
    const now = Date.now();
    let removed = 0;
    for (const name of readdirSync(root)) {
        if (!name.endsWith(".json"))
            continue;
        const path = join(root, name);
        try {
            const entry = JSON.parse(readFileSync(path, "utf8"));
            if (entry.version !== CACHE_VERSION || now >= entry.expiresAt) {
                rmSync(path, { force: true });
                removed += 1;
            }
        }
        catch {
            rmSync(path, { force: true });
            removed += 1;
        }
    }
    return removed;
}
/** Deletes every cached response. Returns the number of deleted files. */
export function clearCache(cwd) {
    const root = cacheRoot(cwd);
    if (!root || !existsSync(root))
        return 0;
    const names = readdirSync(root).filter((name) => name.endsWith(".json"));
    for (const name of names)
        rmSync(join(root, name), { force: true });
    return names.length;
}
/**
 * runOpenAiCompatible with a local response cache. Repeated runs of the same
 * diff (CI retries, hooks, slicing re-runs) do not call the API again.
 */
export async function cachedRunOpenAi(options) {
    const { cwd, ttlSeconds, dailyLimit, ...api } = options;
    const enforceDailyLimit = () => {
        if (!dailyLimit || dailyLimit <= 0)
            return;
        const used = countApiCallsSince(readStats(cwd), todayStartMs());
        if (used >= dailyLimit) {
            throw new PilotError(`Дневной лимит API-вызовов oc-pilot исчерпан (${used}/${dailyLimit}).`, { hint: "Кеш всё ещё работает (--no-cache обходить не стоит); лимит задаётся maxDailyApiCalls / OC_PILOT_MAX_DAILY_API_CALLS.", exitCode: 1 });
        }
    };
    if (ttlSeconds <= 0) {
        enforceDailyLimit();
        const direct = await runOpenAiCompatible(api);
        recordApiCall(cwd, { model: api.model, cached: false, durationMs: direct.durationMs });
        return direct;
    }
    const root = cacheRoot(cwd);
    if (!root)
        return runOpenAiCompatible(api);
    const key = cacheKey(api);
    const now = Date.now();
    const hit = readEntry(root, key, now);
    if (hit !== undefined) {
        log.detail("Ответ движка взят из локального кеша (без вызова API).");
        recordApiCall(cwd, { model: api.model, cached: true, durationMs: 0 });
        return { text: hit, durationMs: 0, stderr: "", cached: true };
    }
    enforceDailyLimit();
    const result = await runOpenAiCompatible(api);
    recordApiCall(cwd, { model: api.model, cached: false, durationMs: result.durationMs });
    writeEntry(root, key, result.text, ttlSeconds, now);
    return { ...result, cached: false };
}
//# sourceMappingURL=cache.js.map