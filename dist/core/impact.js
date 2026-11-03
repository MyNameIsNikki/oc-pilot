import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { runGit } from "./git.js";
const MAX_SYMBOLS = 25;
const MAX_REFERENCES_PER_SYMBOL = 10;
const MAX_REFERENCES = 60;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_SCANNED_FILES = 5_000;
/** Short and generic names produce nothing but noise when grepped repo-wide. */
const RESERVED = new Set([
    "args",
    "argv",
    "body",
    "call",
    "catch",
    "class",
    "count",
    "data",
    "done",
    "entry",
    "error",
    "event",
    "false",
    "file",
    "files",
    "func",
    "handler",
    "index",
    "init",
    "input",
    "item",
    "items",
    "json",
    "list",
    "main",
    "name",
    "node",
    "null",
    "options",
    "output",
    "params",
    "path",
    "props",
    "query",
    "render",
    "request",
    "response",
    "result",
    "results",
    "return",
    "rows",
    "size",
    "state",
    "test",
    "text",
    "true",
    "type",
    "types",
    "value",
    "values",
]);
const DECLARATIONS = [
    { kind: "function", pattern: /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
    {
        kind: "function",
        pattern: /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function\b)/,
    },
    { kind: "def", pattern: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
    { kind: "func", pattern: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/ },
    { kind: "fn", pattern: /\bfn\s+([A-Za-z_]\w*)/ },
    { kind: "type", pattern: /\b(?:export\s+)?(?:class|interface|enum|type|struct|trait)\s+([A-Za-z_$][\w$]*)/ },
];
const HUNK_HEADER = /^@@\s*-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;
function acceptsName(name) {
    if (name.length < 4)
        return false;
    if (RESERVED.has(name.toLowerCase()))
        return false;
    return true;
}
function fileOfDiffHeader(line) {
    const raw = line.slice(4).trim();
    if (raw === "/dev/null")
        return undefined;
    return raw.replace(/^[ab]\//, "");
}
/**
 * Extracts the symbols a diff actually introduces or removes. The goal is a
 * short list a human can sanity-check, so constructors of anonymous callbacks
 * and generic names are filtered out instead of flooding the report.
 */
export function extractChangedSymbols(diff) {
    const symbols = [];
    const seen = new Set();
    let file = "";
    let lineNumber = 0;
    const record = (content, atLine) => {
        for (const { kind, pattern } of DECLARATIONS) {
            const match = pattern.exec(content);
            if (!match)
                continue;
            const name = match[1];
            if (!acceptsName(name))
                continue;
            const key = `${kind}:${name}`;
            if (seen.has(key))
                break;
            seen.add(key);
            symbols.push({ name, kind, file, line: atLine });
            break;
        }
    };
    for (const line of diff.split("\n")) {
        if (line.startsWith("+++ ")) {
            file = fileOfDiffHeader(line) ?? "";
            continue;
        }
        if (line.startsWith("--- ") || line.startsWith("diff --git ") || line.startsWith("index ")) {
            continue;
        }
        const hunk = HUNK_HEADER.exec(line);
        if (hunk) {
            lineNumber = Number(hunk[1]);
            continue;
        }
        if (!file)
            continue;
        if (line.startsWith("+")) {
            record(line.slice(1), lineNumber);
            lineNumber += 1;
        }
        else if (line.startsWith("-")) {
            record(line.slice(1), lineNumber);
        }
        else if (line.startsWith(" ")) {
            lineNumber += 1;
        }
    }
    return symbols.slice(0, MAX_SYMBOLS);
}
function listRepoFiles(cwd) {
    const result = runGit(["ls-files", "-co", "--exclude-standard", "--full-name", "-z"], cwd);
    if (result.status !== 0)
        return [];
    return result.stdout
        .split("\0")
        .filter((entry) => entry.length > 0)
        .slice(0, MAX_SCANNED_FILES);
}
function normalizeEntry(cwd, entry) {
    const absolute = isAbsolute(entry) ? entry : resolve(cwd, entry);
    const rel = relative(cwd, absolute).split(sep).join("/");
    if (rel.startsWith(".."))
        return undefined;
    if (rel.split("/").some((part) => part === "node_modules" || part === "dist" || part === ".git")) {
        return undefined;
    }
    return rel;
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/**
 * Finds usages of the changed symbols in untouched files. It is a plain textual
 * search on purpose: no language server, no AST, no repository index to keep in
 * sync - just enough signal to warn that a rename has other call sites.
 */
export function findSymbolReferences(cwd, symbols, touchedFiles) {
    if (symbols.length === 0)
        return { references: [], scannedFiles: 0 };
    const touched = new Set(touchedFiles);
    const byName = new Map(symbols.map((symbol) => [symbol.name, symbol]));
    const matcher = new RegExp(`\\b(${[...byName.keys()].map(escapeRegExp).join("|")})\\b`, "g");
    const perSymbol = new Map();
    const references = [];
    let scannedFiles = 0;
    for (const entry of listRepoFiles(cwd)) {
        const rel = normalizeEntry(cwd, entry);
        if (!rel || touched.has(rel))
            continue;
        const absolute = join(cwd, rel);
        let content;
        try {
            const stats = statSync(absolute);
            if (!stats.isFile() || stats.size > MAX_FILE_BYTES)
                continue;
            content = readFileSync(absolute, "utf8");
        }
        catch {
            continue;
        }
        if (content.includes("\0"))
            continue;
        scannedFiles += 1;
        const lines = content.split("\n");
        for (let index = 0; index < lines.length; index += 1) {
            const text = lines[index];
            matcher.lastIndex = 0;
            if (!matcher.test(text))
                continue;
            matcher.lastIndex = 0;
            let match;
            while ((match = matcher.exec(text)) !== null) {
                const symbol = match[1];
                const used = perSymbol.get(symbol) ?? 0;
                if (used >= MAX_REFERENCES_PER_SYMBOL)
                    break;
                perSymbol.set(symbol, used + 1);
                references.push({ symbol, file: rel, line: index + 1, text: text.trim().slice(0, 120) });
                if (references.length >= MAX_REFERENCES)
                    return { references, scannedFiles };
            }
        }
    }
    return { references, scannedFiles };
}
export function analyzeImpact(cwd, diff, changedFiles) {
    const symbols = extractChangedSymbols(diff);
    const { references, scannedFiles } = findSymbolReferences(cwd, symbols, changedFiles);
    return { symbols, references, scannedFiles, touchedFiles: changedFiles };
}
export function describeImpact(report) {
    if (report.symbols.length === 0)
        return "Изменённых объявлений не найдено.";
    const lines = [];
    for (const symbol of report.symbols) {
        const hits = report.references.filter((reference) => reference.symbol === symbol.name);
        const head = `${symbol.name} (${symbol.kind}) — ${symbol.file}:${symbol.line}`;
        if (hits.length === 0) {
            lines.push(head);
            continue;
        }
        lines.push(head);
        for (const hit of hits) {
            lines.push(`  ${hit.file}:${hit.line}  ${hit.text}`);
        }
    }
    return lines.join("\n");
}
//# sourceMappingURL=impact.js.map