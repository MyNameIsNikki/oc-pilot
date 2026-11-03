import { readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { PilotError } from "./errors.js";
import { runGit } from "./git.js";
import { loadSecretIgnore, scanText } from "./secrets.js";
const MAX_FILES = 5_000;
const MAX_FILE_BYTES = 512 * 1024;
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", ".git"]);
function listFiles(cwd) {
    const result = runGit(["ls-files", "-co", "--exclude-standard", "--full-name", "-z"], cwd);
    if (result.status !== 0) {
        throw new PilotError("Не удалось получить список файлов репозитория.", {
            hint: "Нужен git-репозиторий. Вне git используйте oc-pilot scan --diff <file>.",
            exitCode: 2,
        });
    }
    return result.stdout.split("\0").filter((entry) => entry.length > 0);
}
function skipEntry(entry) {
    const parts = entry.split("/");
    return parts.some((part) => SKIP_DIRECTORIES.has(part));
}
/**
 * Scans every tracked and untracked (but not ignored) file in the repository.
 * `.gitignore` decides what belongs to the project at all, `.oc-pilot/ignore`
 * additionally silences fixtures and generated files from the secret scanner.
 */
export function scanTree(cwd) {
    const ignore = loadSecretIgnore(cwd);
    const findings = [];
    const seen = new Set();
    let files = 0;
    let skipped = 0;
    for (const entry of listFiles(cwd)) {
        if (files >= MAX_FILES)
            break;
        const rel = entry.split(sep).join("/");
        if (skipEntry(rel)) {
            skipped += 1;
            continue;
        }
        let content;
        try {
            const absolute = resolve(cwd, entry);
            const computed = relative(cwd, absolute).split(sep).join("/");
            if (computed.startsWith("..")) {
                skipped += 1;
                continue;
            }
            const stats = statSync(absolute);
            if (!stats.isFile() || stats.size > MAX_FILE_BYTES) {
                skipped += 1;
                continue;
            }
            content = readFileSync(join(cwd, entry), "utf8");
        }
        catch {
            skipped += 1;
            continue;
        }
        if (content.includes("\0")) {
            skipped += 1;
            continue;
        }
        files += 1;
        const scan = scanText(content, rel, { ignore, entropy: true });
        for (const finding of scan.findings) {
            const key = `${finding.file}:${finding.line}:${finding.kind}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            findings.push(finding);
        }
    }
    return { findings, files, skipped };
}
//# sourceMappingURL=tree-scan.js.map