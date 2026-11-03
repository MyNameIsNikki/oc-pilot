import { extname } from "node:path";
import { isCodeFile, isGeneratedPath, isTestFile } from "./source.js";
const MAX_DECLARATIONS_PER_FILE = 500;
const MAX_DEAD = 2_000;
const ENTRY_FILE = /(^|\/)(index|main|cli|mcp|setup|vite\.config|next\.config)\.[cm]?[jt]sx?$|(^|\/)(bin|scripts|cmd)\//;
const JS_DECL = /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;
const JS_EXPORT_LIST = /^\s*export\s*(?:type\s*)?\{([^}]*)\}/;
const GO_DECL = /^(?:func|type|var|const)\s+([A-Z]\w*)/;
const PY_DECL = /^(?:async\s+def|def|class)\s+([A-Za-z]\w*)/;
function declarationsOf(file) {
    const extension = extname(file.path).toLowerCase();
    const found = [];
    file.text.split("\n").forEach((line, index) => {
        const at = index + 1;
        if (found.length >= MAX_DECLARATIONS_PER_FILE)
            return;
        if (extension === ".go") {
            const match = GO_DECL.exec(line);
            if (match)
                found.push({ name: match[1], line: at, kind: "symbol" });
            return;
        }
        if (extension === ".py") {
            const match = PY_DECL.exec(line);
            if (match && !match[1].startsWith("_")) {
                found.push({ name: match[1], line: at, kind: line.trimStart().startsWith("class") ? "class" : "function" });
            }
            return;
        }
        const direct = JS_DECL.exec(line);
        if (direct) {
            // Type-only exports never ship and are routinely used only inside their
            // own module, so reporting them as dead code would be pure noise.
            if (direct[1] === "interface" || direct[1] === "type")
                return;
            found.push({ name: direct[2], line: at, kind: direct[1] });
            return;
        }
        if (/^\s*export\s+type\s*\{/.test(line))
            return;
        const list = JS_EXPORT_LIST.exec(line);
        if (list) {
            for (const specifier of list[1].split(",")) {
                const parts = specifier.trim().replace(/^type\s+/, "").split(/\s+as\s+/);
                const name = (parts[1] ?? parts[0] ?? "").trim();
                if (/^[A-Za-z_$][\w$]*$/.test(name) && name !== "default") {
                    found.push({ name, line: at, kind: "export" });
                }
            }
        }
    });
    return found;
}
function identifierSet(text) {
    const set = new Set();
    for (const match of text.matchAll(/[A-Za-z_$][\w$]*/g))
        set.add(match[0]);
    return set;
}
function ignoredFile(path) {
    return isTestFile(path) || isGeneratedPath(path) || ENTRY_FILE.test(path) || !isCodeFile(path);
}
/**
 * An export is dead when no other file in the repository mentions its name.
 * The check is intentionally textual: dynamic access through strings counts as
 * a reference only when the name appears somewhere else.
 */
export function findDeadExports(allFiles, maxDead = 500) {
    if (allFiles.length < 2)
        return [];
    const corpus = allFiles.map((file) => ({
        path: file.path.replace(/\\/g, "/"),
        text: file.text,
        names: identifierSet(file.text),
    }));
    const dead = [];
    for (const entry of corpus) {
        if (ignoredFile(entry.path))
            continue;
        for (const declaration of declarationsOf({ path: entry.path, text: entry.text })) {
            if (declaration.name.length <= 2 || declaration.name.startsWith("_"))
                continue;
            const referenced = corpus.some((other) => other.path !== entry.path && other.names.has(declaration.name));
            if (referenced)
                continue;
            dead.push({
                file: entry.path,
                line: declaration.line,
                name: declaration.name,
                kind: declaration.kind,
            });
            if (dead.length >= MAX_DEAD)
                break;
        }
        if (dead.length >= MAX_DEAD)
            break;
    }
    dead.sort((x, y) => x.file.localeCompare(y.file) || x.line - y.line);
    return dead.slice(0, maxDead);
}
//# sourceMappingURL=dead-exports.js.map