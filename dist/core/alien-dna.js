import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { splitDiffBlocks } from "./diff.js";
import { isGitRepo, runGit } from "./git.js";
import { readAtRef, readRepository } from "./slop/collect.js";
import { isCodeFile, isGeneratedPath, stripCode } from "./slop/source.js";
const MAX_FILES = 3_000;
const MAX_FILE_BYTES = 512 * 1024;
const SKIP_DIRS = new Set([
    ".git",
    ".oc-pilot",
    "node_modules",
    "dist",
    "build",
    "out",
    "coverage",
    "vendor",
    ".next",
    "target",
]);
/** Ordered pattern table. The first trigger drives the headline. */
export const PATTERNS = [
    {
        id: "singleton",
        label: "Singleton class",
        message: "The agent used a Singleton class.",
        detect: (code) => /\bstatic\s+getInstance\s*\(/.test(code) ||
            /\bprivate\s+static\s+(?:readonly\s+)?instance\b/.test(code) ||
            /\bprivate\s+constructor\s*\(/.test(code),
    },
    {
        id: "proxy",
        label: "Proxy object",
        message: "The agent used a Proxy object.",
        detect: (code) => /\bnew\s+Proxy\s*\(/.test(code),
    },
    {
        id: "dynamic-regex",
        label: "dynamic regular expression",
        message: "The agent used a dynamic regular expression.",
        detect: (code) => /\bnew\s+RegExp\s*\(/.test(code),
    },
    {
        id: "eval",
        label: "dynamic code execution",
        message: "The agent used dynamic code execution.",
        detect: (code) => /(?<![.\w$])eval\s*\(/.test(code) || /\bnew\s+Function\s*\(/.test(code),
    },
    {
        id: "global-state",
        label: "global mutable state",
        message: "The agent used global mutable state.",
        detect: (code) => /\bglobalThis\.[A-Za-z_$][\w$]*\s*=/.test(code),
    },
    {
        id: "inheritance",
        label: "class inheritance",
        message: "The agent used class inheritance.",
        detect: (code) => /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+[A-Za-z_$][\w$]*\s+extends\s+/.test(code),
    },
    {
        id: "decorator",
        label: "decorator",
        message: "The agent used a decorator.",
        detect: (code) => /^\s*@[A-Za-z_$][\w$]*(?:\s*\(|$)/.test(code),
    },
    {
        id: "worker",
        label: "worker thread",
        message: "The agent used a worker thread.",
        detect: (code) => /\bnew\s+Worker\s*\(/.test(code),
    },
    {
        id: "event-emitter",
        label: "event emitter",
        message: "The agent used an event emitter.",
        detect: (code) => /\bnew\s+EventEmitter\s*\(/.test(code),
    },
    {
        id: "dynamic-import",
        label: "dynamic import",
        message: "The agent used a dynamic import.",
        detect: (code) => /\bimport\s*\(/.test(code),
    },
    {
        id: "sync-io",
        label: "synchronous I/O",
        message: "The agent used synchronous I/O.",
        detect: (code) => /\b(?:readFileSync|writeFileSync|appendFileSync|execSync|spawnSync)\s*\(/.test(code),
    },
    {
        id: "prototype-mutation",
        label: "prototype mutation",
        message: "The agent mutated a prototype.",
        detect: (code) => /\b[A-Za-z_$][\w$]*\.prototype\.[A-Za-z_$][\w$]*\s*=/.test(code),
    },
];
const PATTERN_ORDER = new Map(PATTERNS.map((pattern, index) => [pattern.id, index]));
function isCommentLine(line) {
    const trimmed = line.trim();
    return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*");
}
function readDiskFiles(cwd) {
    const root = resolve(cwd);
    const files = [];
    const walk = (dir) => {
        if (files.length >= MAX_FILES)
            return;
        try {
            const entries = readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (files.length >= MAX_FILES)
                    return;
                if (entry.isSymbolicLink())
                    continue;
                const absolute = join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (SKIP_DIRS.has(entry.name))
                        continue;
                    walk(absolute);
                    continue;
                }
                if (!entry.isFile())
                    continue;
                const path = relative(root, absolute).replace(/\\/g, "/");
                if (!isCodeFile(path) || isGeneratedPath(path))
                    continue;
                try {
                    if (statSync(absolute).size > MAX_FILE_BYTES)
                        continue;
                    const text = readFileSync(absolute, "utf8");
                    files.push({ path, text: text.startsWith("\uFEFF") ? text.slice(1) : text });
                }
                catch {
                    continue;
                }
            }
        }
        catch {
            return;
        }
    };
    walk(root);
    return files.sort((left, right) => left.path.localeCompare(right.path));
}
function currentFiles(cwd) {
    if (isGitRepo(cwd)) {
        try {
            return readRepository(cwd).files;
        }
        catch {
            return readDiskFiles(cwd);
        }
    }
    return readDiskFiles(cwd);
}
/** Reads the baseline tree: HEAD when available, otherwise the working tree. */
export function collectBaseline(cwd) {
    if (isGitRepo(cwd) && runGit(["rev-parse", "--verify", "HEAD"], cwd).status === 0) {
        const listed = runGit(["ls-tree", "-r", "--name-only", "-z", "HEAD"], cwd);
        if (listed.status === 0) {
            const paths = listed.stdout
                .split("\0")
                .filter(Boolean)
                .map((path) => path.replace(/\\/g, "/"))
                .filter((path) => isCodeFile(path) && !isGeneratedPath(path))
                .sort()
                .slice(0, MAX_FILES);
            const files = readAtRef(cwd, "HEAD", paths).filter((file) => file.text.length > 0);
            return { label: "HEAD", files };
        }
    }
    return { label: "working tree", files: currentFiles(cwd) };
}
/** Counts every pattern in the baseline files. */
export function collectDna(files) {
    const stats = PATTERNS.map((pattern) => ({
        id: pattern.id,
        label: pattern.label,
        message: pattern.message,
        count: 0,
        files: 0,
    }));
    const byId = new Map(stats.map((stat) => [stat.id, stat]));
    const touched = new Map();
    for (const file of files) {
        for (const line of file.text.split(/\r?\n/)) {
            if (!line.trim() || isCommentLine(line))
                continue;
            const code = stripCode(line, file.path);
            for (const pattern of PATTERNS) {
                if (!pattern.detect(code))
                    continue;
                const stat = byId.get(pattern.id);
                if (!stat)
                    continue;
                stat.count += 1;
                let paths = touched.get(pattern.id);
                if (!paths) {
                    paths = new Set();
                    touched.set(pattern.id, paths);
                }
                paths.add(file.path);
            }
        }
    }
    for (const stat of stats)
        stat.files = touched.get(stat.id)?.size ?? 0;
    return stats;
}
/** Extracts added lines with their line numbers in the new file. */
export function collectAddedLines(diff) {
    const added = [];
    for (const block of splitDiffBlocks(diff)) {
        if (block.path === "(unknown)" || block.path === "(diff)")
            continue;
        let line = 0;
        let inHunk = false;
        for (const raw of block.text.split(/\r?\n/)) {
            if (raw === "")
                continue;
            const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
            if (hunk) {
                line = Number(hunk[1]);
                inHunk = true;
                continue;
            }
            if (!inHunk)
                continue;
            if (raw.startsWith("+")) {
                added.push({ path: block.path, line, text: raw.slice(1) });
                line += 1;
                continue;
            }
            if (raw.startsWith("-") || raw.startsWith("\\"))
                continue;
            line += 1;
        }
    }
    return added;
}
export function renderAlienDna(report) {
    const lines = [
        `Alien DNA: база ${report.baseline}, файлов ${String(report.files)}, добавленных строк ${String(report.addedLines)}`,
        "Паттерны:",
    ];
    for (const pattern of report.patterns) {
        lines.push(`  ${pattern.id.padEnd(20)} ${String(pattern.count).padStart(4)} (${String(pattern.files)} файлов)`);
    }
    if (report.triggers.length > 0) {
        lines.push("", "Триггеры:");
        for (const trigger of report.triggers) {
            lines.push(`  ${trigger.path}:${String(trigger.line)} ${trigger.id} — ${trigger.evidence}`);
        }
    }
    lines.push("", report.summary);
    return `${lines.join("\n")}\n`;
}
/** Compares added diff lines with the architecture DNA of the baseline. */
export function analyzeAlienDna(cwd, diff) {
    const baseline = collectBaseline(cwd);
    const patterns = collectDna(baseline.files);
    const stats = new Map(patterns.map((pattern) => [pattern.id, pattern]));
    const added = collectAddedLines(diff);
    const triggers = [];
    const seen = new Set();
    for (const line of added) {
        if (!isCodeFile(line.path) || isGeneratedPath(line.path))
            continue;
        const code = stripCode(line.text, line.path);
        for (const pattern of PATTERNS) {
            if (!pattern.detect(code))
                continue;
            if ((stats.get(pattern.id)?.count ?? 0) > 0)
                continue;
            const key = `${pattern.id}:${line.path}:${String(line.line)}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            triggers.push({
                id: pattern.id,
                label: pattern.label,
                message: pattern.message,
                path: line.path,
                line: line.line,
                evidence: line.text.trim().slice(0, 200),
            });
        }
    }
    triggers.sort((left, right) => {
        const order = (PATTERN_ORDER.get(left.id) ?? 0) - (PATTERN_ORDER.get(right.id) ?? 0);
        if (order !== 0)
            return order;
        const path = left.path.localeCompare(right.path);
        return path !== 0 ? path : left.line - right.line;
    });
    const summary = triggers.length === 0
        ? "Архитектурная ДНК совпадает: чужих паттернов нет."
        : `[ALIEN DNA DETECTED]: ${triggers[0].message} This pattern has 0% occurrence in your codebase. Architecture drift blocked.`;
    const report = {
        baseline: baseline.label,
        files: baseline.files.length,
        addedLines: added.length,
        patterns,
        triggers,
        summary,
    };
    return { ...report, content: renderAlienDna(report) };
}
//# sourceMappingURL=alien-dna.js.map