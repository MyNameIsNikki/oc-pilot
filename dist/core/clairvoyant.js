import { dirname, extname, join } from "node:path";
import { collectChangedFiles } from "./diff.js";
import { extractChangedSymbols } from "./impact.js";
import { readRepository } from "./slop/collect.js";
import { isTestFile } from "./slop/source.js";
const CODE_EXTENSIONS = [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".mts",
    ".cts",
    ".go",
    ".py",
    ".rs",
    ".java",
    ".kt",
    ".rb",
    ".php",
    ".cs",
    ".swift",
];
function normalize(path) {
    return path.replace(/\\/g, "/");
}
function importSpecifiers(text) {
    const specs = [];
    const patterns = [
        /(?:from|require\(|import\()\s*["']([^"']+)["']/g,
        /import\s+["']([^"']+)["']/g,
    ];
    for (const pattern of patterns) {
        for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
            if (match[1])
                specs.push(match[1]);
        }
    }
    return [...new Set(specs)];
}
function variants(base) {
    const result = [base];
    const ext = extname(base);
    const stem = ext ? base.slice(0, -ext.length) : base;
    if (ext) {
        for (const candidate of CODE_EXTENSIONS)
            result.push(`${stem}${candidate}`);
    }
    for (const candidate of CODE_EXTENSIONS)
        result.push(`${base}${candidate}`);
    for (const candidate of CODE_EXTENSIONS)
        result.push(`${base}/index${candidate}`);
    return result;
}
function resolveImport(testPath, spec, known) {
    if (!spec.startsWith("."))
        return undefined;
    const base = normalize(join(dirname(testPath), spec));
    for (const candidate of variants(base)) {
        if (known.has(candidate))
            return candidate;
    }
    return undefined;
}
function namingCandidates(changedPath) {
    const ext = extname(changedPath);
    const stem = ext ? changedPath.slice(0, -ext.length) : changedPath;
    const file = stem.split("/").pop() ?? stem;
    const candidates = [
        `${stem}.test${ext}`,
        `${stem}.spec${ext}`,
        `test/${file}.test${ext}`,
        `tests/${file}.test${ext}`,
        `__tests__/${file}.test${ext}`,
        `test/${file}${ext}`,
        `tests/${file}${ext}`,
        `${stem}_test${ext}`,
        `${stem}_test.go`,
        `test_${file}.py`,
    ];
    return [...new Set(candidates.map(normalize))];
}
/** Maps changed files and symbols to the tests that are most likely affected. */
export function analyzeClairvoyant(cwd, diff) {
    const changedFiles = collectChangedFiles(diff).filter((path) => path !== "(unknown)" && path !== "(diff)");
    const changedSet = new Set(changedFiles);
    const symbols = extractChangedSymbols(diff);
    const repo = readRepository(cwd);
    const known = new Set(repo.files.map((file) => normalize(file.path)));
    const tests = repo.files.filter((file) => isTestFile(file.path));
    const results = [];
    for (const test of tests) {
        const path = normalize(test.path);
        const reasons = new Set();
        for (const spec of importSpecifiers(test.text)) {
            const resolved = resolveImport(path, spec, known);
            if (resolved && changedSet.has(resolved))
                reasons.add(`import:${resolved}`);
        }
        for (const symbol of symbols) {
            const pattern = new RegExp(`\\b${symbol.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
            if (pattern.test(test.text))
                reasons.add(`symbol:${symbol.name}`);
        }
        for (const changed of changedFiles) {
            if (namingCandidates(changed).includes(path))
                reasons.add(`name:${changed}`);
        }
        if (reasons.size > 0)
            results.push({ path, reasons: [...reasons].sort() });
    }
    results.sort((left, right) => left.path.localeCompare(right.path));
    const predicted = results.filter((test) => test.reasons.some((reason) => reason.startsWith("symbol:") || reason.startsWith("import:")));
    const scope = (predicted.length > 0 ? predicted : results).map((test) => test.path);
    const summary = scope.length > 0
        ? `[CI SCOPE]: ${String(scope.length)} тестов покрывают изменение; полный набор не обязателен.`
        : "[CI SCOPE]: затронутых тестов не найдено; запустите полный набор.";
    const report = {
        changedFiles,
        symbols,
        tests: results,
        scope,
        summary,
        content: "",
    };
    report.content = renderClairvoyant(report);
    return report;
}
export function renderClairvoyant(report) {
    const scope = new Set(report.scope);
    const lines = [
        `Clairvoyant: ${String(report.scope.length)} test(s), ${String(report.changedFiles.length)} changed file(s), ${String(report.symbols.length)} symbol(s)`,
        `Changed: ${report.changedFiles.join(", ") || "нет"}`,
    ];
    if (report.symbols.length > 0) {
        lines.push(`Symbols: ${report.symbols.map((symbol) => symbol.name).join(", ")}`);
    }
    if (report.tests.length === 0) {
        lines.push("Tests: ни один тестовый файл не ссылается на изменение.");
    }
    else {
        lines.push("Tests:");
        for (const test of report.tests) {
            const mark = scope.has(test.path) ? "[IN SCOPE]" : "[CANDIDATE]";
            lines.push(`  ${mark} ${test.path} — ${test.reasons.join(", ")}`);
        }
    }
    lines.push(`Scope: ${report.scope.join(" ") || "полный набор"}`);
    lines.push("", report.summary);
    return `${lines.join("\n")}\n`;
}
//# sourceMappingURL=clairvoyant.js.map