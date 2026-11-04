import { analyzeChurn } from "./churn.js";
import { collectCommits, readRepository } from "./collect.js";
import { isCodeFile, isGeneratedPath, isTestFile } from "./source.js";
import { findDuplicates } from "./duplicates.js";
import { findTodos } from "./todos.js";
const DEFAULT_LIMIT = 3;
const DEFAULT_MAX_CHARS = 24_000;
const SINCE_DAYS = 30;
function stemOf(path) {
    const normalized = path.replace(/\\/g, "/");
    const stem = normalized.replace(/\.[^./]+$/, "");
    const base = stem.slice(stem.lastIndexOf("/") + 1);
    return { stem, base };
}
/** Maps a test file path to the lowercase stem of the module it tests. */
function testedStemOf(path) {
    if (!isTestFile(path))
        return undefined;
    const { stem, base } = stemOf(path);
    let cleaned = base.replace(/\.(test|spec)$/, "");
    cleaned = cleaned.replace(/_test$/, "");
    if (!/\.(test|spec|snap)$/.test(base) && !/_test$/.test(base)) {
        cleaned = cleaned.replace(/Test$/, "");
    }
    if (cleaned.startsWith("test_") && cleaned.length > "test_".length)
        cleaned = cleaned.slice("test_".length);
    const dir = stem.slice(0, stem.length - base.length);
    return `${dir}${cleaned}`.toLowerCase();
}
/** Stems of every module that some test file already covers. */
export function buildTestIndex(paths) {
    const index = new Set();
    for (const path of paths) {
        const stem = testedStemOf(path);
        if (stem !== undefined)
            index.add(stem);
    }
    return index;
}
/** Best-effort check: does any test file in the index cover `file`? */
export function hasTestFile(file, testedStems) {
    const { stem, base } = stemOf(file);
    return testedStems.has(stem.toLowerCase()) || testedStems.has(base.toLowerCase());
}
/**
 * Pure ranking: given repository files, slop signals and the test index,
 * returns the files most worth writing tests for.
 */
export function rankTestTargets(files, signals, testedStems, options = {}) {
    const limit = options.limit ?? DEFAULT_LIMIT;
    const maxCharsPerFile = options.maxCharsPerFile ?? DEFAULT_MAX_CHARS;
    const churn = new Map(signals.churn.map((entry) => [entry.file, entry]));
    const duplicates = new Map();
    for (const pair of signals.duplicates) {
        for (const side of [pair.first, pair.second]) {
            const entry = duplicates.get(side.file) ?? { blocks: 0, tokens: 0 };
            entry.blocks += 1;
            entry.tokens += pair.tokens;
            duplicates.set(side.file, entry);
        }
    }
    const todos = new Map();
    for (const item of signals.todos) {
        todos.set(item.file, (todos.get(item.file) ?? 0) + 1);
    }
    const targets = [];
    for (const file of files) {
        const path = file.path.replace(/\\/g, "/");
        if (!isCodeFile(path) || isTestFile(path) || isGeneratedPath(path))
            continue;
        if (hasTestFile(path, testedStems))
            continue;
        if (file.text.trim().length === 0 || file.text.length > maxCharsPerFile)
            continue;
        const lines = file.text.split("\n");
        while (lines.length > 0 && lines[lines.length - 1] === "")
            lines.pop();
        const reasons = [];
        let score = 0;
        const churnEntry = churn.get(path);
        if (churnEntry) {
            score += churnEntry.commits + (churnEntry.testCommits === 0 ? 4 : 0);
            reasons.push(`churn: ${String(churnEntry.commits)} commits over ${String(churnEntry.days)} days, test files changed ${String(churnEntry.testCommits)} times`);
        }
        const duplicateEntry = duplicates.get(path);
        if (duplicateEntry) {
            score += duplicateEntry.blocks + duplicateEntry.tokens / 200;
            reasons.push(`duplicates: ${String(duplicateEntry.blocks)} blocks (~${String(duplicateEntry.tokens)} tokens)`);
        }
        const todoCount = todos.get(path);
        if (todoCount) {
            score += todoCount * 0.8;
            reasons.push(`todos: ${String(todoCount)}`);
        }
        if (reasons.length === 0) {
            score = Math.min(lines.length / 200, 5);
            reasons.push(`no entropy signal yet: untested file, ${String(lines.length)} lines`);
        }
        targets.push({
            file: path,
            lines: lines.length,
            score: Math.round(score * 100) / 100,
            reasons,
            commits: churnEntry?.commits,
            testCommits: churnEntry?.testCommits,
            days: churnEntry?.days,
            duplicateBlocks: duplicateEntry?.blocks,
            duplicateTokens: duplicateEntry?.tokens,
            todos: todoCount,
        });
    }
    targets.sort((x, y) => y.score - x.score || y.lines - x.lines || x.file.localeCompare(y.file));
    return targets.slice(0, limit);
}
/** Unified diff that introduces each target file, so the model sees the code. */
export function syntheticTargetDiff(files) {
    const blocks = [];
    for (const file of files) {
        const lines = file.text.split("\n");
        while (lines.length > 0 && lines[lines.length - 1] === "")
            lines.pop();
        if (lines.length === 0)
            continue;
        blocks.push([
            `diff --git a/${file.path} b/${file.path}`,
            "new file mode 100644",
            "--- /dev/null",
            `+++ b/${file.path}`,
            `@@ -0,0 +1,${String(lines.length)} @@`,
            lines.map((line) => `+${line}`).join("\n"),
        ].join("\n"));
    }
    return blocks.length > 0 ? `${blocks.join("\n")}\n` : "";
}
/** Scans the repository and picks the test targets with the highest debt. */
export function selectTestTargets(cwd, options = {}) {
    const loaded = readRepository(cwd, { sinceDays: options.sinceDays });
    const commits = collectCommits(cwd, { sinceDays: options.sinceDays ?? SINCE_DAYS });
    const churn = analyzeChurn(commits, { minCommits: 5, limit: 500 });
    const duplicatePairs = findDuplicates(loaded.files);
    const todoItems = findTodos(loaded.files);
    const testedStems = buildTestIndex(loaded.files.map((file) => file.path));
    const codeFiles = loaded.files.filter((file) => isCodeFile(file.path) && !isTestFile(file.path) && !isGeneratedPath(file.path));
    const untested = codeFiles.filter((file) => !hasTestFile(file.path, testedStems)).length;
    const targets = rankTestTargets(loaded.files, { churn, duplicates: duplicatePairs, todos: todoItems }, testedStems, {
        limit: options.limit,
        maxCharsPerFile: options.maxCharsPerFile,
    });
    const byPath = new Map(loaded.files.map((file) => [file.path, file]));
    return {
        targets,
        filesScanned: codeFiles.length,
        untested,
        payloadDiff: syntheticTargetDiff(targets.map((target) => byPath.get(target.file)).filter((file) => file !== undefined)),
    };
}
/** English prompt block describing the selected targets. */
export function formatTestTargets(targets) {
    if (targets.length === 0)
        return "";
    const lines = targets.map((target) => `- ${target.file}  ${target.reasons.join("; ")}`);
    return [
        "TEST_DEBT_TARGETS: untested files chosen by the slop scan (churn, duplicates, TODOs). Write tests for these files:",
        ...lines,
    ].join("\n");
}
/** Short Russian summary of one target, for the CLI log. */
export function describeTarget(target) {
    if (target.commits !== undefined) {
        return `${String(target.commits)} коммитов / ${String(target.testCommits)} с тестами`;
    }
    if (target.duplicateBlocks)
        return `${String(target.duplicateBlocks)} дублей`;
    if (target.todos)
        return `${String(target.todos)} TODO`;
    return `${String(target.lines)} строк без тестов`;
}
//# sourceMappingURL=test-debt.js.map