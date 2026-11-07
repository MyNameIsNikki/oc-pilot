import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseTarget } from "./last-review.js";
/** How many lines from the top of a file may carry `oc-pilot:ignore-file`. */
const FILE_SCOPE_LINES = 10;
/** Cap on entries copied into the JSON report, so a bad run cannot bloat it. */
const MAX_REPORTED = 50;
const MARKER = /oc-pilot:ignore(?<kind>-file|-secret)?\b(?<rest>[^\n]*)$/i;
/**
 * Reads a suppression marker from one source line. `-secret` belongs to the
 * secret scanner, not to finding suppression, so it is ignored here on
 * purpose: matching it would silently hide real review findings.
 */
function markerOn(line) {
    if (typeof line !== "string")
        return undefined;
    const match = MARKER.exec(line);
    if (!match?.groups)
        return undefined;
    const kind = match.groups.kind;
    if (kind === "-secret")
        return undefined;
    let rest = (match.groups.rest ?? "").replace(/\s*(?:\*\/|--!?>)\s*$/, "");
    rest = rest.replace(/^[\s:—–-]+/, "");
    return { scope: kind === "-file" ? "file" : "line", reason: rest.trim() };
}
function fileLines(cwd, file, cache) {
    if (cache.has(file))
        return cache.get(file);
    let lines;
    try {
        // Findings use repository-relative paths; resolve keeps absolute ones intact.
        lines = readFileSync(resolve(cwd, file), "utf8")
            .replace(/^\uFEFF/, "")
            .split(/\r?\n/);
    }
    catch {
        lines = undefined;
    }
    cache.set(file, lines);
    return lines;
}
/**
 * Drops findings suppressed in the source itself, ESLint-style. A marker is
 * read from the target line, the line above it, or the first lines of the file
 * (`oc-pilot:ignore-file`). The reason is mandatory: `oc-pilot:ignore` without
 * text is reported to the caller and the finding is kept.
 */
export function applySuppressions(cwd, findings) {
    const cache = new Map();
    const kept = [];
    const suppressed = [];
    let missingReason = 0;
    for (const finding of findings) {
        const target = finding.location ? parseTarget(finding.location) : undefined;
        const lines = target ? fileLines(cwd, target.file, cache) : undefined;
        if (!target || !lines) {
            kept.push(finding);
            continue;
        }
        const fileMarker = lines
            .slice(0, FILE_SCOPE_LINES)
            .map(markerOn)
            .find((marker) => marker?.scope === "file");
        const lineMarker = [lines[target.line - 1], lines[target.line - 2]]
            .map(markerOn)
            .find((marker) => marker?.scope === "line");
        const marker = fileMarker ?? lineMarker;
        if (!marker) {
            kept.push(finding);
            continue;
        }
        if (!marker.reason) {
            missingReason += 1;
            kept.push(finding);
            continue;
        }
        suppressed.push({
            finding,
            file: target.file,
            line: target.line,
            reason: marker.reason,
            scope: marker.scope,
        });
    }
    return { kept, suppressed, missingReason };
}
/** Compact shape of the suppression report stored in `meta.suppressed`. */
export function describeSuppressions(suppressed) {
    return {
        count: suppressed.length,
        entries: suppressed.slice(0, MAX_REPORTED).map(({ file, line, reason, scope }) => ({ file, line, reason, scope })),
    };
}
export { FILE_SCOPE_LINES, MAX_REPORTED };
//# sourceMappingURL=suppressions.js.map