import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PilotError } from "./errors.js";
export const BASELINE_VERSION = 1;
export const DEFAULT_BASELINE_PATH = ".oc-pilot/baseline.json";
function fingerprint(parts) {
    return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);
}
/** A SAST finding keeps its identity when the file moves lines or gains whitespace. */
export function sastFingerprint(finding) {
    return fingerprint(["sast", finding.rule, finding.file, finding.snippet.trim()]);
}
/** A route finding is identified by the rule and the route it protects. */
export function authzFingerprint(finding) {
    return fingerprint(["authz", finding.rule, finding.file, finding.method, finding.route]);
}
export function emptyBaseline() {
    return { version: BASELINE_VERSION, sast: [], authz: [] };
}
function stringArray(value) {
    return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}
export function loadFindingsBaseline(cwd, file = DEFAULT_BASELINE_PATH) {
    const path = resolve(cwd, file);
    if (!existsSync(path))
        return { path, baseline: emptyBaseline(), exists: false };
    let data;
    try {
        data = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
    }
    catch {
        throw new PilotError(`Не удалось прочитать baseline: ${file}`, {
            hint: "Файл baseline должен содержать JSON, созданный через --update-baseline.",
            exitCode: 2,
        });
    }
    const record = typeof data === "object" && data !== null ? data : {};
    return {
        path,
        exists: true,
        baseline: {
            version: BASELINE_VERSION,
            sast: stringArray(record.sast),
            authz: stringArray(record.authz),
        },
    };
}
export function saveFindingsBaseline(cwd, file, baseline) {
    const path = resolve(cwd, file);
    mkdirSync(dirname(path), { recursive: true });
    const payload = {
        version: BASELINE_VERSION,
        sast: [...new Set(baseline.sast)].sort(),
        authz: [...new Set(baseline.authz)].sort(),
    };
    writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return path;
}
//# sourceMappingURL=findings-baseline.js.map