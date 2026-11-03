import { analyzeChurn } from "./churn.js";
import { changedFiles, collectCommits, lineAges, readAtRef, readRepository, readSourceFiles, } from "./collect.js";
import { findDeadExports } from "./dead-exports.js";
import { findDuplicates } from "./duplicates.js";
import { buildReport, compareSlop } from "./score.js";
import { findTodos } from "./todos.js";
const DEFAULT_SINCE_DAYS = 30;
function statsOf(files, truncated) {
    let lines = 0;
    for (const file of files) {
        for (let index = 0; index < file.text.length; index += 1) {
            if (file.text.charCodeAt(index) === 10)
                lines += 1;
        }
    }
    return { filesScanned: files.length, linesScanned: lines, truncated };
}
/** Full-repository scan: the default mode. */
export function analyzeRepository(cwd, options = {}) {
    const loaded = readRepository(cwd, { exclude: options.exclude, sinceDays: options.sinceDays });
    const commits = collectCommits(cwd, { sinceDays: options.sinceDays ?? DEFAULT_SINCE_DAYS });
    const ages = lineAges(cwd, options.blame !== false);
    const limit = options.limit ?? 10;
    const duplicates = findDuplicates(loaded.files);
    const deadExports = findDeadExports(loaded.files);
    const churn = analyzeChurn(commits, { minCommits: options.minCommits ?? 5, limit: 500 });
    const todos = findTodos(loaded.files, { lineAge: ages });
    const report = buildReport({
        duplicates,
        deadExports,
        churn,
        todos,
        stats: statsOf(loaded.files, loaded.truncated),
    });
    return { ...report, ...limitReport(report, limit) };
}
function limitReport(report, limit) {
    return {
        duplicates: report.duplicates.slice(0, limit),
        deadExports: report.deadExports.slice(0, limit),
        churn: report.churn.slice(0, limit),
        todos: report.todos.slice(0, limit),
    };
}
/**
 * Delta mode: analyses the same set of changed files on both sides of `ref`, so
 * the comparison stays fair even when the branch only touches a few modules.
 */
export function analyzeAgainst(cwd, ref, options = {}) {
    const paths = changedFiles(cwd, ref);
    const currentFiles = readSourceFiles(cwd, paths);
    const baseFiles = readAtRef(cwd, ref, paths);
    const commits = collectCommits(cwd, { range: `${ref}..HEAD` });
    const limit = options.limit ?? 10;
    const baseAges = lineAges(cwd, options.blame !== false, ref);
    const build = (files, ages, truncated) => buildReport({
        duplicates: findDuplicates(files),
        deadExports: findDeadExports(files),
        churn: analyzeChurn(commits, { minCommits: options.minCommits ?? 5, limit: 500 }),
        todos: findTodos(files, { lineAge: ages }),
        stats: statsOf(files, truncated),
    });
    const current = build(currentFiles, lineAges(cwd, options.blame !== false), false);
    const base = build(baseFiles, baseAges, false);
    const delta = compareSlop(base, current, ref);
    return {
        current: { ...current, ...limitReport(current, limit) },
        base: { ...base, ...limitReport(base, limit) },
        delta,
    };
}
//# sourceMappingURL=index.js.map