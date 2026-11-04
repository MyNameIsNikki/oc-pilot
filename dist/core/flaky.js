const ANSI = /\u001B\[[0-9;]*m/g;
/** Strips ANSI colors so status markers survive any reporter. */
export function stripAnsi(text) {
    return text.replace(ANSI, "");
}
const PATTERNS = [
    // node:test spec reporter
    { status: "pass", regex: /^\s*\u2714\s+(.+?)(?:\s+\(\d+(?:\.\d+)?\s*m?s\))?\s*$/ },
    { status: "fail", regex: /^\s*[\u2716\u2717]\s+(.+?)(?:\s+\(\d+(?:\.\d+)?\s*m?s\))?\s*$/ },
    // TAP
    { status: "pass", regex: /^ok\s+\d+\s+-\s+(.+?)\s*$/ },
    { status: "fail", regex: /^not ok\s+\d+\s+-\s+(.+?)\s*$/ },
    // go test
    { status: "pass", regex: /^--- PASS:\s+(\S+)/ },
    { status: "fail", regex: /^--- FAIL:\s+(\S+)/ },
    // pytest -v
    { status: "pass", regex: /^PASSED\s+(\S+)/ },
    { status: "fail", regex: /^FAILED\s+(\S+)/ },
    // jest / vitest
    { status: "pass", regex: /^\s*\u2713\s+(.+?)(?:\s+\(\d+(?:\.\d+)?\s*m?s\))?\s*$/ },
    { status: "fail", regex: /^\s*[\u2715\u00d7]\s+(.+?)(?:\s+\(\d+(?:\.\d+)?\s*m?s\))?\s*$/ },
];
/** Extracts per-test pass/fail markers from common reporter output. */
export function parseTestOutput(output) {
    const results = new Map();
    for (const rawLine of stripAnsi(output).split(/\r?\n/)) {
        for (const { status, regex } of PATTERNS) {
            const match = regex.exec(rawLine);
            if (match?.[1]) {
                results.set(match[1].trim(), status);
                break;
            }
        }
    }
    return results;
}
/** Aggregates per-run results into stable, failing and flaky tests. */
export function classifyRuns(runs) {
    const totals = new Map();
    for (const run of runs) {
        for (const [name, status] of run) {
            const entry = totals.get(name) ?? { passes: 0, failures: 0 };
            if (status === "pass")
                entry.passes += 1;
            else
                entry.failures += 1;
            totals.set(name, entry);
        }
    }
    const outcomes = [];
    for (const [name, entry] of totals) {
        const status = entry.passes > 0 && entry.failures > 0 ? "flaky" : entry.failures > 0 ? "failing" : "passing";
        outcomes.push({ name, passes: entry.passes, failures: entry.failures, status });
    }
    const rank = { flaky: 0, failing: 1, passing: 2 };
    outcomes.sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
    return outcomes;
}
/** Builds the report from completed runs. */
export function buildFlakyReport(command, runs) {
    const parsedRuns = runs.map((run) => parseTestOutput(run.output));
    const parsed = parsedRuns.some((run) => run.size > 0);
    const tests = parsed ? classifyRuns(parsedRuns) : [];
    return {
        command,
        runs: runs.length,
        completed: runs.filter((run) => run.exitCode !== null && !run.timedOut).length,
        parsed,
        tests,
        flaky: tests.filter((test) => test.status === "flaky"),
        failing: tests.filter((test) => test.status === "failing"),
    };
}
/** Human-readable summary. */
export function renderFlaky(report) {
    const lines = [
        `Команда: ${report.command}`,
        `Прогонов: ${String(report.runs)} (завершено ${String(report.completed)}).`,
    ];
    if (!report.parsed) {
        lines.push("Не удалось распознать отдельные тесты в выводе — проверьте коды возврата вручную.");
        return `${lines.join("\n")}\n`;
    }
    lines.push(`Тестов распознано: ${String(report.tests.length)}.`);
    if (report.flaky.length === 0) {
        lines.push("Нестабильных тестов не найдено.");
    }
    else {
        lines.push(`Нестабильные (${String(report.flaky.length)}):`);
        for (const test of report.flaky) {
            lines.push(`  ${test.name} — упал в ${String(test.failures)} из ${String(report.runs)} прогонов`);
        }
    }
    if (report.failing.length > 0) {
        lines.push(`Всегда падают (${String(report.failing.length)}):`);
        for (const test of report.failing)
            lines.push(`  ${test.name}`);
    }
    return `${lines.join("\n")}\n`;
}
//# sourceMappingURL=flaky.js.map