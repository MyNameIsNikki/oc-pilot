import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getRepoRoot, isGitRepo, runGit } from "./git.js";
const LAST_REVIEW_VERSION = 1;
const MAX_STORED_FINDINGS = 200;
function gitDir(cwd) {
    if (!isGitRepo(cwd))
        return undefined;
    const repoRoot = getRepoRoot(cwd);
    const result = runGit(["rev-parse", "--git-dir"], repoRoot);
    if (result.status !== 0)
        return undefined;
    const raw = result.stdout.trim();
    return /^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(raw) ? raw : join(repoRoot, raw);
}
/**
 * The store lives inside `.git`, so a review of a dirty tree never leaves
 * artifacts behind in the working tree or in a commit.
 */
export function lastReviewPath(cwd) {
    const dir = gitDir(cwd);
    return dir ? join(dir, "oc-pilot", "last-review.json") : undefined;
}
export function saveLastReview(cwd, review) {
    const path = lastReviewPath(cwd);
    if (!path)
        return undefined;
    const payload = {
        version: LAST_REVIEW_VERSION,
        createdAt: new Date().toISOString(),
        recipe: review.recipe,
        model: review.model,
        findings: review.findings.slice(0, MAX_STORED_FINDINGS),
    };
    try {
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
        return path;
    }
    catch {
        // Diagnostics must never break a review that already succeeded.
        return undefined;
    }
}
export function loadLastReview(cwd) {
    const path = lastReviewPath(cwd);
    if (!path || !existsSync(path))
        return undefined;
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (parsed.version !== LAST_REVIEW_VERSION || !Array.isArray(parsed.findings)) {
            return undefined;
        }
        return parsed;
    }
    catch {
        return undefined;
    }
}
/** Parses `src/file.ts:42` into a file and a line number. */
export function parseTarget(value) {
    const match = /^(.*?):(\d+)(?::\d+)?$/.exec(value.trim());
    if (!match)
        return undefined;
    const file = (match[1] ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
    const line = Number.parseInt(match[2] ?? "", 10);
    if (!file || !Number.isFinite(line) || line <= 0)
        return undefined;
    return { file, line };
}
function findingTarget(finding) {
    return finding.location ? parseTarget(finding.location) : undefined;
}
/**
 * Prefers an exact line, then findings a few lines away (models often point at
 * the statement above the problem), then anything else in the same file.
 */
export function matchFindings(findings, target, nearLines = 3) {
    const inFile = findings.filter((finding) => {
        const parsed = findingTarget(finding);
        return parsed !== undefined && parsed.file === target.file;
    });
    const exact = inFile.filter((finding) => findingTarget(finding)?.line === target.line);
    if (exact.length > 0)
        return exact;
    const near = inFile.filter((finding) => {
        const parsed = findingTarget(finding);
        return parsed !== undefined && Math.abs(parsed.line - target.line) <= nearLines;
    });
    return near.length > 0 ? near : inFile;
}
//# sourceMappingURL=last-review.js.map