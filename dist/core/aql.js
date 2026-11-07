import { PilotError } from "./errors.js";
import { readRepository } from "./slop/collect.js";
import { isCodeFile, isGeneratedPath } from "./slop/source.js";
const KEYWORDS = new Set([
    "if",
    "for",
    "while",
    "switch",
    "catch",
    "function",
    "return",
    "typeof",
    "instanceof",
    "new",
    "await",
    "yield",
    "super",
    "import",
    "require",
]);
const FUNCTION = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/;
const ARROW = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/;
const CLASS = /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/;
const IMPORT = /^\s*import\s+(?:type\s+)?(?:[^"']+?\s+from\s+)?["']([^"']+)["']/;
const CALL = /\b([A-Za-z_$][\w$]*)\s*\(/g;
/** Builds a lightweight code graph from repository files. */
export function collectAqlNodes(cwd) {
    const nodes = [];
    for (const file of readRepository(cwd).files) {
        if (!isCodeFile(file.path) || isGeneratedPath(file.path))
            continue;
        const rows = file.text.split("\n");
        nodes.push({ id: `File:${file.path}`, type: "File", name: file.path, file: file.path, line: 1 });
        for (let index = 0; index < rows.length; index += 1) {
            const line = rows[index];
            const lineNo = index + 1;
            const functionMatch = FUNCTION.exec(line);
            const arrowMatch = ARROW.exec(line);
            const classMatch = CLASS.exec(line);
            const importMatch = IMPORT.exec(line);
            if (functionMatch?.[1]) {
                nodes.push({ id: `Function:${file.path}:${String(lineNo)}:${functionMatch[1]}`, type: "Function", name: functionMatch[1], file: file.path, line: lineNo });
            }
            if (arrowMatch?.[1]) {
                nodes.push({ id: `Function:${file.path}:${String(lineNo)}:${arrowMatch[1]}`, type: "Function", name: arrowMatch[1], file: file.path, line: lineNo });
            }
            if (classMatch?.[1]) {
                nodes.push({ id: `Class:${file.path}:${String(lineNo)}:${classMatch[1]}`, type: "Class", name: classMatch[1], file: file.path, line: lineNo });
            }
            if (importMatch?.[1]) {
                nodes.push({
                    id: `Import:${file.path}:${String(lineNo)}:${importMatch[1]}`,
                    type: "Import",
                    name: importMatch[1],
                    file: file.path,
                    line: lineNo,
                    specifier: importMatch[1],
                });
            }
            for (const match of line.matchAll(CALL)) {
                const name = match[1];
                if (!name || KEYWORDS.has(name))
                    continue;
                nodes.push({
                    id: `CallExpression:${file.path}:${String(lineNo)}:${name}:${String(match.index ?? 0)}`,
                    type: "CallExpression",
                    name,
                    file: file.path,
                    line: lineNo,
                });
            }
        }
    }
    return nodes;
}
/** Splits a chain by top-level dots, respecting quotes and parentheses. */
export function splitAql(query) {
    const stages = [];
    let current = "";
    let depth = 0;
    let quote;
    for (let index = 0; index < query.length; index += 1) {
        const char = query[index];
        if (quote) {
            current += char;
            if (char === "\\") {
                current += query[index + 1] ?? "";
                index += 1;
            }
            else if (char === quote) {
                quote = undefined;
            }
            continue;
        }
        if (char === '"' || char === "'" || char === "`") {
            quote = char;
            current += char;
            continue;
        }
        if (char === "(")
            depth += 1;
        if (char === ")")
            depth -= 1;
        if (char === "." && depth === 0) {
            stages.push(current.trim());
            current = "";
            continue;
        }
        current += char;
    }
    if (current.trim())
        stages.push(current.trim());
    return stages.filter((stage) => stage.length > 0);
}
function parseCall(stage) {
    const match = /^([A-Za-z]+)\s*\((.*)\)$/s.exec(stage);
    if (!match?.[1]) {
        throw new PilotError(`Неверный шаг AQL: ${stage}`, {
            hint: 'Пример: find(CallExpression).where(name, "stripe").select(file, line)',
            exitCode: 2,
        });
    }
    const args = [];
    let current = "";
    let quote;
    for (const char of match[2] ?? "") {
        if (quote) {
            if (char === quote)
                quote = undefined;
            else
                current += char;
            continue;
        }
        if (char === '"' || char === "'" || char === "`") {
            quote = char;
            continue;
        }
        if (char === ",") {
            args.push(current.trim());
            current = "";
            continue;
        }
        current += char;
    }
    if (current.trim())
        args.push(current.trim());
    return { name: match[1], args };
}
function valueOf(raw) {
    const value = raw.trim();
    if (value === "true")
        return true;
    if (value === "false")
        return false;
    if (/^-?\d+(?:\.\d+)?$/.test(value))
        return Number(value);
    return value;
}
/** Executes a chainable AQL query against the code graph. */
export function runAql(cwd, query, options = {}) {
    const stages = splitAql(query);
    if (stages.length === 0 || !stages[0].startsWith("find")) {
        throw new PilotError("AQL должен начинаться с find(Type)", {
            hint: 'Например: find(CallExpression).where(name, "stripe").select(file, line)',
            exitCode: 2,
        });
    }
    const all = collectAqlNodes(cwd);
    const limit = Math.max(1, Math.min(1000, options.limit ?? 200));
    let current = all;
    let type = "";
    let selected = false;
    let countOnly = false;
    for (const stage of stages) {
        const { name, args } = parseCall(stage);
        if (name === "find") {
            type = args[0] ?? "";
            current = current.filter((node) => String(node.type) === type);
        }
        else if (name === "where") {
            const field = args[0] ?? "";
            const value = valueOf(args[1] ?? "");
            current = current.filter((node) => String(node[field] ?? "") === String(value));
        }
        else if (name === "sort") {
            const field = args[0] ?? "";
            current = [...current].sort((left, right) => String(left[field] ?? "").localeCompare(String(right[field] ?? "")));
        }
        else if (name === "limit") {
            const value = Number(args[0] ?? limit);
            current = current.slice(0, Number.isFinite(value) ? Math.max(0, value) : limit);
        }
        else if (name === "select") {
            const fields = args.length > 0 ? args : ["file", "line", "type", "name"];
            current = current.map((node) => Object.fromEntries(fields.map((field) => [field, node[field]])));
            selected = true;
        }
        else if (name === "count") {
            countOnly = true;
        }
        else {
            throw new PilotError(`Неизвестный шаг AQL: ${name}`, {
                hint: "Доступно: find, where, sort, limit, select, count.",
                exitCode: 2,
            });
        }
    }
    if (!selected && !countOnly)
        current = current.slice(0, limit);
    const rows = countOnly ? [] : current;
    const count = countOnly ? current.length : rows.length;
    const content = countOnly
        ? `${String(count)} node(s) for ${type || "any type"}\n`
        : [
            `${String(count)} node(s) for ${type || "any type"}`,
            ...rows.map((row) => Object.values(row).map((value) => String(value ?? "")).join("  ")),
        ].join("\n") + "\n";
    return { query, type, count, rows, content };
}
//# sourceMappingURL=aql.js.map