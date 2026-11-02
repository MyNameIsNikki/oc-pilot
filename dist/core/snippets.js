import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
const SOURCE_EXTENSIONS = "go|rs|py|pyi|ts|tsx|mts|cts|js|jsx|mjs|cjs|java|kt|kts|cs|c|cc|cpp|cxx|h|hpp|rb|php|swift|scala|sh|ps1|sql|lua|ex|exs|dart";
const PATH_PATTERN = new RegExp(String.raw `(?:^|[\s("'\[])((?:[A-Za-z]:[\\/]|\/|\.{1,2}[\\/])?[A-Za-z0-9_@./\\-]+\.(?:${SOURCE_EXTENSIONS}))(?::(\d+))?`, "g");
const PYTHON_PATTERN = /File "([^"]+\.(?:py|pyi))", line (\d+)/g;
const DOTNET_PATTERN = /(?:in )?([A-Za-z]:\\[^:\n]+?\.cs):line (\d+)/gi;
const IGNORED_SEGMENTS = [
    "node_modules",
    ".git",
    "dist",
    "build",
    "target",
    "vendor",
    "coverage",
    ".next",
    "__pycache__",
];
function isIgnored(absolute, cwd) {
    const rel = relative(cwd, absolute).replace(/\\/g, "/");
    if (rel.startsWith(".."))
        return true;
    return IGNORED_SEGMENTS.some((segment) => rel.split("/").includes(segment));
}
function resolveCandidate(raw, cwd) {
    const cleaned = raw.trim().replace(/[),.;]+$/, "");
    if (!cleaned || cleaned.includes("://"))
        return undefined;
    const candidates = [];
    if (/^[A-Za-z]:[\\/]/.test(cleaned) || isAbsolute(cleaned)) {
        candidates.push(resolve(cleaned));
    }
    else if (!cleaned.split(/[\\/]/).includes("..")) {
        let directory = cwd;
        for (let depth = 0; depth < 5; depth += 1) {
            candidates.push(resolve(directory, cleaned));
            const parent = dirname(directory);
            if (parent === directory)
                break;
            directory = parent;
        }
    }
    for (const candidate of candidates) {
        try {
            if (existsSync(candidate) && statSync(candidate).isFile() && !isIgnored(candidate, cwd)) {
                return candidate;
            }
        }
        catch {
            // Ignore stat races and permission errors.
        }
    }
    return undefined;
}
function collectCandidates(output, cwd) {
    const found = new Map();
    const add = (rawPath, line) => {
        const absolute = resolveCandidate(rawPath, cwd);
        if (!absolute)
            return;
        const existing = found.get(absolute);
        if (!existing) {
            found.set(absolute, { absolute, line });
        }
        else if (existing.line === undefined && line !== undefined) {
            existing.line = line;
        }
    };
    for (const match of output.matchAll(PYTHON_PATTERN))
        add(match[1], Number(match[2]));
    for (const match of output.matchAll(DOTNET_PATTERN))
        add(match[1], Number(match[2]));
    for (const match of output.matchAll(PATH_PATTERN))
        add(match[1], match[2] ? Number(match[2]) : undefined);
    return found;
}
function formatSnippet(absolute, cwd, line, radius) {
    try {
        if (statSync(absolute).size > 2 * 1024 * 1024)
            return undefined;
        const content = readFileSync(absolute, "utf8");
        const lines = content.split(/\r?\n/);
        if (lines.length === 0)
            return undefined;
        const display = relative(cwd, absolute).replace(/\\/g, "/") || absolute;
        let start;
        let end;
        let heading;
        if (line !== undefined && Number.isFinite(line)) {
            const target = Math.min(Math.max(1, line), lines.length);
            start = Math.max(1, target - radius);
            end = Math.min(lines.length, target + radius);
            heading = `${display}:${target} (строки ${start}-${end})`;
        }
        else {
            start = 1;
            end = Math.min(lines.length, 30);
            heading = `${display} (первые ${end} строк)`;
        }
        const width = String(end).length;
        const body = [];
        for (let current = start; current <= end; current += 1) {
            const prefix = current === line ? ">" : " ";
            body.push(`${prefix} ${String(current).padStart(width, " ")} | ${lines[current - 1] ?? ""}`);
        }
        return [`--- ${heading} ---`, ...body].join("\n");
    }
    catch {
        return undefined;
    }
}
/**
 * Finds source files referenced by a test failure output and returns compact
 * excerpts around the reported line numbers.
 */
export function extractSnippets(output, cwd, options = {}) {
    const maxFiles = options.maxFiles ?? 6;
    const radius = options.radius ?? 10;
    const candidates = [...collectCandidates(output, cwd).values()].slice(0, maxFiles);
    const snippets = [];
    const files = [];
    for (const candidate of candidates) {
        const snippet = formatSnippet(candidate.absolute, cwd, candidate.line, radius);
        if (snippet) {
            snippets.push(snippet);
            files.push(relative(cwd, candidate.absolute).replace(/\\/g, "/"));
        }
    }
    return { text: snippets.join("\n\n"), files };
}
//# sourceMappingURL=snippets.js.map