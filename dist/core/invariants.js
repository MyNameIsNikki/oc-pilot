import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { getRepoRoot, isGitRepo, runGit } from "./git.js";
import { buildImportGraph, reverseClosure } from "./import-graph.js";
import { detectProjectType } from "./project.js";
import { executeRecipeDetailed } from "./run.js";
const CACHE_VERSION = 1;
const CACHE_LIMIT = 20;
/** Parses the semantic lock file: `## area`, `- [CRITICAL] text`. */
export function parseInvariants(text) {
    const items = [];
    let area;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        const heading = /^#{2,3}\s+(.+?)\s*$/.exec(line);
        if (heading?.[1]) {
            area = heading[1].trim();
            continue;
        }
        const item = /^[-*]\s+(?:\[(CRITICAL)\]\s*)?(.+)$/i.exec(line);
        if (!item?.[2])
            continue;
        const critical = Boolean(item[1]);
        const body = item[2].trim();
        if (!body)
            continue;
        items.push({
            id: `INV-${String(items.length + 1).padStart(3, "0")}`,
            text: body,
            critical,
            area,
        });
    }
    return items;
}
export function invariantsPath(cwd) {
    return resolve(cwd, ".oc-pilot", "invariants.md");
}
export function readInvariants(cwd) {
    const path = invariantsPath(cwd);
    if (!existsSync(path))
        return undefined;
    const text = readFileSync(path, "utf8");
    return { path, text, items: parseInvariants(text) };
}
/** Changed files plus every file that transitively imports them. */
export function relatedFiles(cwd, changedFiles) {
    const result = new Set(changedFiles);
    try {
        const graph = buildImportGraph(cwd);
        for (const file of reverseClosure(graph, changedFiles))
            result.add(file);
    }
    catch {
        // The scope check still works from the changed files when the graph fails.
    }
    return result;
}
function areaTokens(area) {
    if (!area)
        return [];
    return area
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((token) => token.length >= 3);
}
/** An invariant is out of scope when its area matches none of the related files. */
export function isInScope(invariant, related) {
    const tokens = areaTokens(invariant.area);
    if (tokens.length === 0)
        return true;
    const paths = [...related].map((file) => file.toLowerCase());
    return tokens.some((token) => paths.some((file) => file.includes(token)));
}
export function scopeInvariants(items, related) {
    const inScope = [];
    const skipped = [];
    for (const item of items) {
        if (isInScope(item, related))
            inScope.push(item);
        else
            skipped.push(item);
    }
    return { inScope, skipped };
}
export function cacheKey(diff, invariantsText) {
    return createHash("sha256").update(diff).update("\u0000").update(invariantsText).digest("hex");
}
function cachePath(cwd) {
    if (!isGitRepo(cwd))
        return undefined;
    const root = getRepoRoot(cwd);
    const gitDir = runGit(["rev-parse", "--git-dir"], root);
    if (gitDir.status !== 0)
        return undefined;
    const raw = gitDir.stdout.trim();
    const resolved = /^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(raw) ? raw : join(root, raw);
    return join(resolved, "oc-pilot", "invariants-cache.json");
}
function readCacheFile(cwd) {
    const path = cachePath(cwd);
    if (!path || !existsSync(path))
        return undefined;
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (parsed.version !== CACHE_VERSION || typeof parsed.entries !== "object")
            return undefined;
        return parsed;
    }
    catch {
        return undefined;
    }
}
export function readCachedVerdicts(cwd, key) {
    const cache = readCacheFile(cwd);
    return cache?.entries[key]?.verdicts;
}
export function writeCachedVerdicts(cwd, key, verdicts) {
    const path = cachePath(cwd);
    if (!path)
        return;
    const cache = readCacheFile(cwd) ?? { version: CACHE_VERSION, entries: {} };
    cache.entries[key] = { at: new Date().toISOString(), verdicts };
    const keys = Object.keys(cache.entries);
    if (keys.length > CACHE_LIMIT) {
        for (const old of keys.slice(0, keys.length - CACHE_LIMIT))
            delete cache.entries[old];
    }
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
    }
    catch {
        // Cache is an optimization; a read-only .git must not fail the check.
    }
}
/** The model prompt asks for strict JSON so the gate never parses prose. */
export function buildInvariantPrompt(items, diff) {
    const list = items
        .map((item) => `- ${item.id}${item.critical ? " (CRITICAL)" : ""}: ${item.text}`)
        .join("\n");
    return [
        "INVARIANT_CHECK: проверь, нарушает ли diff инварианты проекта.",
        'Ответь строго JSON без Markdown: {"verdicts":[{"id":"INV-001","status":"pass|violation|unknown","evidence":"кратко","file":"path","line":123}]}.',
        "Для каждого инварианта верни ровно один вердикт. violation — только если diff действительно нарушает инвариант; unknown — если данных не хватает. Не выдумывай файлы, строки и нарушения.",
        "INVARIANTS:",
        list,
        "DIFF:",
        diff,
    ].join("\n\n");
}
function normalizeStatus(value) {
    return value === "pass" || value === "violation" || value === "unknown" ? value : "unknown";
}
/** Extracts the JSON verdicts and fills every invariant exactly once. */
export function parseVerdicts(text, items) {
    let parsed;
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
        try {
            parsed = JSON.parse(text.slice(start, end + 1));
        }
        catch {
            parsed = undefined;
        }
    }
    const rawList = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray(parsed.verdicts)
            ? parsed.verdicts
            : [];
    const byId = new Map();
    for (const raw of rawList) {
        if (!raw || typeof raw !== "object")
            continue;
        const record = raw;
        if (typeof record.id === "string")
            byId.set(record.id, record);
    }
    return items.map((item) => {
        const record = byId.get(item.id);
        const line = typeof record?.line === "number" && Number.isFinite(record.line) ? record.line : undefined;
        return {
            id: item.id,
            text: item.text,
            critical: item.critical,
            status: normalizeStatus(record?.status),
            evidence: typeof record?.evidence === "string" ? record.evidence : record ? "" : "Модель не вернула вердикт",
            file: typeof record?.file === "string" ? record.file : undefined,
            line,
        };
    });
}
export function skippedVerdicts(items) {
    return items.map((item) => ({
        id: item.id,
        text: item.text,
        critical: item.critical,
        status: "skipped",
        evidence: "[SKIPPED: Out of scope]",
    }));
}
export function gateExitCode(verdicts, options = {}) {
    const violations = verdicts.filter((verdict) => verdict.status === "violation");
    if (violations.some((verdict) => verdict.critical))
        return 3;
    if (options.strict === true && violations.length > 0)
        return 3;
    return 0;
}
export function buildInvariantsReport(file, verdicts, cacheHit, options = {}) {
    const violations = verdicts.filter((verdict) => verdict.status === "violation");
    const skipped = verdicts.filter((verdict) => verdict.status === "skipped");
    return {
        file,
        total: verdicts.length,
        checked: verdicts.length - skipped.length,
        skipped: skipped.length,
        violations: violations.length,
        criticalViolations: violations.filter((verdict) => verdict.critical).length,
        cacheHit,
        exitCode: gateExitCode(verdicts, options),
        verdicts,
        content: renderInvariants(verdicts),
    };
}
/** Runs the scoped model check and returns a ready report, including cache and skip markers. */
export async function checkInvariants(cwd, ctx, input, options = {}) {
    const loaded = readInvariants(cwd);
    if (!loaded || loaded.items.length === 0) {
        return buildInvariantsReport(null, [], false, options);
    }
    const related = relatedFiles(cwd, input.changedFiles);
    const { inScope, skipped } = scopeInvariants(loaded.items, related);
    let checked = [];
    let cacheHit = false;
    if (inScope.length > 0) {
        const key = cacheKey(input.payloadDiff, loaded.text);
        const cached = options.noCache === true ? undefined : readCachedVerdicts(cwd, key);
        if (cached && cached.length === inScope.length) {
            checked = cached;
            cacheHit = true;
        }
        else {
            const result = await executeRecipeDetailed({
                recipe: "custom",
                projectType: detectProjectType(cwd, input.changedFiles),
                additionalContext: buildInvariantPrompt(inScope, input.payloadDiff),
                diff: input.payloadDiff,
                secretFindings: input.findings ?? [],
                changedFiles: input.changedFiles,
                meta: { source: input.source ?? "diff", check: "invariants" },
            }, ctx);
            checked = parseVerdicts(result.analysis ?? "", inScope);
            if (options.noCache !== true)
                writeCachedVerdicts(cwd, key, checked);
        }
    }
    return buildInvariantsReport(relative(cwd, loaded.path).replaceAll("\\", "/"), [...checked, ...skippedVerdicts(skipped)], cacheHit, options);
}
export function renderInvariants(verdicts) {
    const violations = verdicts.filter((verdict) => verdict.status === "violation");
    const skipped = verdicts.filter((verdict) => verdict.status === "skipped");
    const lines = [
        `Инварианты: проверено ${String(verdicts.length - skipped.length)}, пропущено ${String(skipped.length)}, нарушений ${String(violations.length)}.`,
    ];
    for (const verdict of verdicts) {
        const where = verdict.file ? ` (${verdict.file}${verdict.line !== undefined ? `:${String(verdict.line)}` : ""})` : "";
        const marker = verdict.status === "violation"
            ? verdict.critical
                ? "[CRITICAL VIOLATION]"
                : "[VIOLATION]"
            : verdict.status === "skipped"
                ? "[SKIPPED: Out of scope]"
                : verdict.status === "pass"
                    ? "[PASS]"
                    : "[UNKNOWN]";
        lines.push(`${marker} ${verdict.id}${verdict.critical ? " [CRITICAL]" : ""}: ${verdict.text}${where}`);
        if (verdict.evidence)
            lines.push(`  ${verdict.evidence}`);
    }
    return `${lines.join("\n")}\n`;
}
//# sourceMappingURL=invariants.js.map