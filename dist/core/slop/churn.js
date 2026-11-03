import { isCodeFile, isGeneratedPath, isTestFile } from "./source.js";
const MAX_TRACKED_FILES = 20_000;
/**
 * Finds files that keep changing while their tests do not. That combination is
 * the cheapest available proxy for "nobody understands this module any more".
 */
export function analyzeChurn(commits, options = {}) {
    const minCommits = options.minCommits ?? 5;
    const limit = options.limit ?? 10;
    const per = new Map();
    for (const commit of commits) {
        const hasTest = commit.files.some(isTestFile);
        const unique = new Set(commit.files);
        for (const raw of unique) {
            const file = raw.replace(/\\/g, "/");
            if (!isCodeFile(file) || isTestFile(file) || isGeneratedPath(file))
                continue;
            let entry = per.get(file);
            if (!entry) {
                if (per.size >= MAX_TRACKED_FILES)
                    continue;
                entry = { commits: 0, testCommits: 0, first: commit.timestamp, last: commit.timestamp };
                per.set(file, entry);
            }
            entry.commits += 1;
            if (hasTest)
                entry.testCommits += 1;
            entry.first = Math.min(entry.first, commit.timestamp);
            entry.last = Math.max(entry.last, commit.timestamp);
        }
    }
    const churn = [];
    for (const [file, entry] of per) {
        if (entry.commits < minCommits)
            continue;
        // Files whose changes are usually covered by tests are healthy churn.
        if (entry.testCommits / entry.commits >= 0.4)
            continue;
        churn.push({
            file,
            commits: entry.commits,
            days: Math.max(1, Math.ceil((entry.last - entry.first) / 86_400_000)),
            testCommits: entry.testCommits,
        });
    }
    churn.sort((x, y) => y.commits - x.commits || x.file.localeCompare(y.file));
    return churn.slice(0, limit);
}
//# sourceMappingURL=churn.js.map