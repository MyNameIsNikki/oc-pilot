import { isOldTodo } from "./todos.js";
const MAX = {
    duplicates: 30,
    deadExports: 25,
    churn: 25,
    todos: 20,
};
const LABELS = {
    duplicates: "Дубликаты",
    deadExports: "Мёртвый код",
    churn: "Churn без тестов",
    todos: "TODO-кладбище",
};
/** Points one new finding adds to the index; used by delta mode. */
const WEIGHTS = {
    duplicates: 2.5,
    deadExports: 1.5,
    churn: 3.5,
    todos: 0.6,
};
const OLD_TODO_DAYS = 90;
function clamp(value, max) {
    return Math.max(0, Math.min(max, Math.round(value)));
}
export function gradeOf(index) {
    if (index <= 20)
        return "чисто";
    if (index <= 45)
        return "умеренно";
    if (index <= 70)
        return "гниёт";
    return "критично";
}
export function scoreCategories(duplicates, deadExports, churn, todos) {
    const oldTodos = todos.filter((item) => isOldTodo(item, OLD_TODO_DAYS)).length;
    return [
        {
            id: "duplicates",
            label: LABELS.duplicates,
            // The block count explodes on large repos, so scale it down: 100 blocks
            // is roughly two thirds of the category, not a hard cap at 12.
            score: clamp(Math.round(Math.sqrt(duplicates.length) * 2.2), MAX.duplicates),
            max: MAX.duplicates,
            metric: `${String(duplicates.length)} блоков`,
        },
        {
            id: "deadExports",
            label: LABELS.deadExports,
            score: clamp(deadExports.length * 0.6, MAX.deadExports),
            max: MAX.deadExports,
            metric: `${String(deadExports.length)} симв.`,
        },
        {
            id: "churn",
            label: LABELS.churn,
            score: clamp(churn.length * 1.8, MAX.churn),
            max: MAX.churn,
            metric: `${String(churn.length)} файлов`,
        },
        {
            id: "todos",
            label: LABELS.todos,
            score: clamp(todos.length * 0.4 + oldTodos * 1.2, MAX.todos),
            max: MAX.todos,
            metric: `${String(todos.length)} шт.${oldTodos > 0 ? `, ${String(oldTodos)} старых` : ""}`,
        },
    ];
}
export function buildReport(input) {
    const categories = scoreCategories(input.duplicates, input.deadExports, input.churn, input.todos);
    const index = Math.max(0, Math.min(100, categories.reduce((sum, category) => sum + category.score, 0)));
    return {
        index,
        grade: gradeOf(index),
        categories,
        duplicates: input.duplicates,
        deadExports: input.deadExports,
        churn: input.churn,
        todos: input.todos,
        stats: input.stats,
    };
}
function bar(score, max) {
    const filled = Math.max(0, Math.min(10, Math.round((score / max) * 10)));
    return `${"█".repeat(filled)}${"░".repeat(10 - filled)}`;
}
function pad(value, width) {
    return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}
function worstLines(report, limit) {
    const lines = [];
    for (const pair of report.duplicates.slice(0, Math.min(2, limit))) {
        lines.push(`${pair.first.file}:${String(pair.first.line)} ↔ ${pair.second.file}:${String(pair.second.line)}  ${String(pair.tokens)} токенов`);
    }
    for (const item of report.deadExports.slice(0, Math.min(2, limit))) {
        lines.push(`${item.file}:${String(item.line)}  ${item.name} не импортируется нигде`);
    }
    for (const item of report.churn.slice(0, Math.min(2, limit))) {
        lines.push(`${item.file}  ${String(item.commits)} коммитов за ${String(item.days)} дн., тесты менялись ${String(item.testCommits)} раз`);
    }
    for (const item of report.todos.slice(0, Math.min(3, limit))) {
        const age = item.ageDays === undefined ? "" : `  ${String(item.ageDays)} дн.`;
        lines.push(`${item.file}:${String(item.line)}  ${item.text}${age}`);
    }
    return lines;
}
export function describeSlop(report, limit = 10) {
    const out = [];
    out.push(`  Slop Index  ${String(report.index)}/100  ${report.grade}`);
    out.push("");
    for (const category of report.categories) {
        out.push(`  ${pad(category.label, 20)}${pad(category.metric, 14)}${bar(category.score, category.max)}  ${String(category.score)}/${String(category.max)}`);
    }
    const worst = worstLines(report, limit);
    if (worst.length > 0) {
        out.push("");
        out.push("  Худшее:");
        for (const line of worst)
            out.push(`    ${line}`);
    }
    out.push("");
    out.push(`  Файлов: ${String(report.stats.filesScanned)} · строк: ${String(report.stats.linesScanned)}${report.stats.truncated ? " · выборка урезана" : ""} · эвристика, не приговор`);
    return `${out.join("\n")}\n`;
}
function badgeColor(index) {
    if (index <= 20)
        return "#3fb950";
    if (index <= 45)
        return "#d29922";
    if (index <= 70)
        return "#db6d28";
    return "#f85149";
}
/** Shields-style SVG badge; write it into a repo or serve it from CI. */
export function badgeSvg(report) {
    const label = "slop";
    const value = `${String(report.index)}/100`;
    const color = badgeColor(report.index);
    const labelWidth = 40;
    const valueWidth = 56;
    const width = labelWidth + valueWidth;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="20" role="img" aria-label="${label}: ${value}">
  <title>${label}: ${value}</title>
  <rect width="${String(labelWidth)}" height="20" fill="#555"/>
  <rect x="${String(labelWidth)}" width="${String(valueWidth)}" height="20" fill="${color}"/>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${String(labelWidth / 2)}" y="14">${label}</text>
    <text x="${String(labelWidth + valueWidth / 2)}" y="14">${value}</text>
  </g>
</svg>`;
}
function keysOf(report) {
    return {
        duplicates: new Set(report.duplicates.map((pair) => `${pair.first.file}|${pair.second.file}|${String(pair.tokens)}`)),
        deadExports: new Set(report.deadExports.map((item) => `${item.file}|${item.name}`)),
        churn: new Set(report.churn.map((item) => item.file)),
        todos: new Set(report.todos.map((item) => `${item.file}|${item.text}`)),
    };
}
export function compareSlop(base, current, baseRef) {
    const before = keysOf(base);
    const after = keysOf(current);
    const order = ["duplicates", "deadExports", "churn", "todos"];
    const categories = [];
    let deltaPoints = 0;
    let introduced = 0;
    let removed = 0;
    for (const id of order) {
        const added = [...after[id]].filter((key) => !before[id].has(key)).length;
        const dropped = [...before[id]].filter((key) => !after[id].has(key)).length;
        categories.push({ id, label: LABELS[id], introduced: added, removed: dropped });
        introduced += added;
        removed += dropped;
        deltaPoints += (added - dropped) * WEIGHTS[id];
    }
    return {
        base: baseRef,
        index: current.index,
        deltaPoints: Math.round(deltaPoints * 10) / 10,
        categories,
        introduced,
        removed,
    };
}
//# sourceMappingURL=score.js.map