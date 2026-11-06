import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { splitDiffBlocks } from "./diff.js";
import { PilotError } from "./errors.js";
import { isCodeFile, isGeneratedPath, isTestFile } from "./slop/source.js";
export const DEFAULT_BOUNDARY_CONFIG = join(".oc-pilot", "architecture.json");
export const STARTER_BOUNDARY_CONFIG = `${JSON.stringify({
    rules: [
        {
            from: "src/ui/**",
            deny: ["src/db/**"],
            reason: "UI не должен импортировать слой БД напрямую",
        },
        {
            from: "src/routes/**",
            deny: ["src/db/**"],
            reason: "Маршруты должны ходить в БД через сервисы",
        },
    ],
}, null, 2)}\n`;
/** Converts a small glob subset (**, *, ?) to a regular expression. */
export function globToRegExp(pattern) {
    const source = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
    let out = "^";
    for (let index = 0; index < source.length; index += 1) {
        const char = source[index];
        if (char === "*") {
            if (source[index + 1] === "*") {
                index += 1;
                if (source[index + 1] === "/") {
                    index += 1;
                    out += "(?:.*/)?";
                }
                else {
                    out += ".*";
                }
            }
            else {
                out += "[^/]*";
            }
            continue;
        }
        if (char === "?") {
            out += "[^/]";
            continue;
        }
        out += /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
    }
    return new RegExp(`${out}$`);
}
/** Matches a repo path or a package specifier against a rule pattern. */
export function matchesBoundary(pattern, value) {
    const normalized = value.replace(/\\/g, "/");
    if (!pattern.includes("/") && !pattern.includes("*") && !pattern.includes("?")) {
        return normalized === pattern || normalized.startsWith(`${pattern}/`);
    }
    return globToRegExp(pattern).test(normalized);
}
/** Validates the architecture config and returns a typed rule list. */
export function parseBoundaryConfig(text, path) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        throw new PilotError(`Не удалось разобрать ${path}`, {
            hint: "Файл архитектуры должен быть корректным JSON.",
            exitCode: 2,
        });
    }
    const rules = parsed?.rules;
    if (!Array.isArray(rules) || rules.length === 0) {
        throw new PilotError(`В ${path} нет правил архитектуры`, {
            hint: 'Ожидается {"rules":[{"from":"src/ui/**","deny":["src/db/**"]}]}.',
            exitCode: 2,
        });
    }
    return {
        rules: rules.map((rule, index) => {
            const value = rule;
            if (typeof value?.from !== "string" || !value.from.trim()) {
                throw new PilotError(`Правило ${String(index + 1)} в ${path} без from`, { exitCode: 2 });
            }
            if (!Array.isArray(value.deny) || value.deny.some((item) => typeof item !== "string")) {
                throw new PilotError(`Правило ${String(index + 1)} в ${path} без списка deny`, { exitCode: 2 });
            }
            return {
                from: value.from,
                deny: value.deny,
                ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
            };
        }),
    };
}
/** Loads an explicit config or the conventional .oc-pilot/architecture.json. */
export function loadBoundaryConfig(cwd, explicit) {
    const path = explicit ?? DEFAULT_BOUNDARY_CONFIG;
    const absolute = join(cwd, path);
    if (!existsSync(absolute)) {
        if (explicit) {
            throw new PilotError(`Файл архитектуры не найден: ${path}`, { exitCode: 2 });
        }
        return undefined;
    }
    return parseBoundaryConfig(readFileSync(absolute, "utf8"), path);
}
const IMPORT_PATTERNS = [
    /^\s*import\s+(?:type\s+)?(?:[^"']+?\s+from\s+)?["']([^"']+)["']/,
    /^\s*export\s+(?:type\s+)?[^"']*?\s+from\s+["']([^"']+)["']/,
    /\brequire\(\s*["']([^"']+)["']\s*\)/,
    /\bimport\(\s*["']([^"']+)["']\s*\)/,
];
/** Resolves a relative or alias import to a repo-relative path. */
export function resolveImport(file, specifier) {
    if (specifier.startsWith("@/"))
        return `src/${specifier.slice(2)}`;
    if (specifier.startsWith(".")) {
        const resolved = normalize(join(dirname(file), specifier)).replace(/\\/g, "/");
        return resolved.replace(/^\.\//, "");
    }
    return specifier;
}
/** Extracts added imports from a unified diff, skipping tests and generated code. */
export function addedImports(diff) {
    const imports = [];
    for (const block of splitDiffBlocks(diff)) {
        if (block.path === "(diff)" || block.path === "(unknown)")
            continue;
        if (!isCodeFile(block.path) || isTestFile(block.path) || isGeneratedPath(block.path))
            continue;
        let newLine = 0;
        for (const line of block.text.split("\n")) {
            const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
            if (hunk) {
                newLine = Number(hunk[1]);
                continue;
            }
            if (line.startsWith("+++") || line.startsWith("---"))
                continue;
            if (line.startsWith("+")) {
                const text = line.slice(1);
                if (!/\bimport\s+type\b/.test(text) && !/\bexport\s+type\b/.test(text)) {
                    for (const pattern of IMPORT_PATTERNS) {
                        const match = pattern.exec(text);
                        if (match?.[1]) {
                            imports.push({ file: block.path, line: newLine, specifier: match[1] });
                            break;
                        }
                    }
                }
                newLine += 1;
            }
            else if (line.startsWith(" ") || line === "") {
                newLine += 1;
            }
        }
    }
    return imports;
}
/** Reports imports that cross a denied architectural boundary. */
export function analyzeBoundaries(diff, config) {
    const imports = addedImports(diff);
    const violations = [];
    const seen = new Set();
    for (const use of imports) {
        const resolved = resolveImport(use.file, use.specifier);
        for (const rule of config.rules) {
            if (!matchesBoundary(rule.from, use.file))
                continue;
            if (!rule.deny.some((pattern) => matchesBoundary(pattern, resolved) || matchesBoundary(pattern, use.specifier))) {
                continue;
            }
            const key = `${use.file}:${String(use.line)}:${rule.from}:${use.specifier}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            violations.push({ file: use.file, line: use.line, imported: use.specifier, resolved, rule });
        }
    }
    violations.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
    return {
        rules: config.rules.length,
        violations,
        scannedFiles: new Set(imports.map((use) => use.file)).size,
        status: violations.length > 0 ? "fail" : "pass",
    };
}
/** Russian summary capped at ten violations. */
export function describeBoundaryViolations(violations) {
    if (violations.length === 0)
        return "Нарушений границ не найдено.";
    const lines = violations.slice(0, 10).map((violation) => {
        const reason = violation.rule.reason ? ` — ${violation.rule.reason}` : "";
        return `- ${violation.file}:${String(violation.line)}: ${violation.imported} запрещён правилом ${violation.rule.from}${reason}`;
    });
    if (violations.length > 10)
        lines.push(`…и ещё ${String(violations.length - 10)}`);
    return lines.join("\n");
}
//# sourceMappingURL=boundaries.js.map