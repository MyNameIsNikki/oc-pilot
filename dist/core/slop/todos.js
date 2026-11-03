import { extname } from "node:path";
import { isCodeFile, isGeneratedPath, isTestFile } from "./source.js";
const MARKER = /\b(TODO|FIXME|HACK|XXX)\b(?!\s*\|)(?:\s*\(([^)]{0,40})\))?\s*[:\-–—]?\s*(.{0,160})/;
const MAX_ITEMS = 2_000;
const STRING_LITERAL = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
/** A JSDoc block line: it explains a marker rather than tracking real work. */
const DOC_COMMENT = /^\s*(?:\/\*\*|\*)/;
/**
 * Markers inside string literals are prose, help text or a regex, not a note
 * left for a human. Blank the literals out before matching.
 */
function withoutStrings(line) {
    return line.replace(STRING_LITERAL, " ");
}
/**
 * Template literals span lines, so a help text or a regex can smuggle the word
 * TODO into the report. Mark every line that sits inside one.
 */
function insideTemplate(lines) {
    const inside = new Array(lines.length).fill(false);
    let open = false;
    for (let index = 0; index < lines.length; index += 1) {
        if (open)
            inside[index] = true;
        const ticks = lines[index].replace(/\\`/g, "").match(/`/g)?.length ?? 0;
        if (ticks % 2 === 1)
            open = !open;
    }
    return inside;
}
/** Languages where a hash starts a comment instead of a private field. */
const HASH_COMMENT = new Set([".py", ".rb", ".sh", ".ps1", ".lua", ".ex", ".exs", ".pl", ".r", ".yml", ".yaml", ".toml"]);
/**
 * Returns the comment part of a line. A marker only counts inside a comment:
 * strings, regexes and code identifiers are not notes for a human.
 */
function commentOf(line, hashComments, state) {
    let start = -1;
    if (state.block) {
        start = 0;
    }
    else {
        for (const opener of ["//", "/*"]) {
            const at = line.indexOf(opener);
            if (at >= 0 && (start < 0 || at < start))
                start = at;
        }
        if (hashComments) {
            const at = line.indexOf("#");
            if (at >= 0 && (start < 0 || at < start))
                start = at;
        }
    }
    if (start < 0)
        return "";
    const close = line.indexOf("*/", start);
    const text = line.slice(start, state.block && close >= 0 ? close + 2 : line.length);
    if (state.block) {
        if (close >= 0)
            state.block = false;
    }
    else {
        const open = line.indexOf("/*", start);
        if (open >= 0 && line.indexOf("*/", open) < 0)
            state.block = true;
    }
    return text;
}
export function isOldTodo(item, thresholdDays = 90) {
    return item.ageDays !== undefined && item.ageDays >= thresholdDays;
}
/**
 * Collects TODO-like markers with their age. Markers in tests and generated
 * files are skipped: fixtures are full of intentional TODOs.
 */
export function findTodos(files, options = {}) {
    const items = [];
    const maxItems = options.maxItems ?? MAX_ITEMS;
    for (const file of files) {
        const path = file.path.replace(/\\/g, "/");
        if (!isCodeFile(path) || isGeneratedPath(path) || isTestFile(path))
            continue;
        const lines = file.text.split("\n");
        const quoted = insideTemplate(lines);
        const hashComments = HASH_COMMENT.has(extname(path).toLowerCase());
        const state = { block: false };
        for (let index = 0; index < lines.length; index += 1) {
            if (quoted[index])
                continue;
            const comment = commentOf(lines[index], hashComments, state);
            if (!comment)
                continue;
            // Documentation blocks describe a marker instead of tracking work.
            if (DOC_COMMENT.test(comment))
                continue;
            const match = MARKER.exec(withoutStrings(comment));
            if (!match)
                continue;
            const owner = match[2]?.trim();
            const note = (match[3] ?? "").trim().replace(/\*\/\s*$/, "");
            const ageDays = options.lineAge?.(path, index + 1);
            items.push({
                file: path,
                line: index + 1,
                text: `${match[1]}${owner ? `(${owner})` : ""}${note ? `: ${note}` : ""}`.slice(0, 180),
                ...(ageDays !== undefined ? { ageDays } : {}),
            });
            if (items.length >= maxItems)
                break;
        }
        if (items.length >= maxItems)
            break;
    }
    items.sort((x, y) => (y.ageDays ?? -1) - (x.ageDays ?? -1) || x.file.localeCompare(y.file));
    return items;
}
//# sourceMappingURL=todos.js.map