import { runGit } from "./git.js";
import { splitDiffBlocks } from "./diff.js";
import { scanSource } from "./sast.js";
import { analyzeTestWeakness } from "./test-weakening.js";
const DEFAULT_HISTORY_DAYS = 90;
const MIN_COMMITS = 10;
const MAX_COMMITS = 200;
const DAY_MS = 86_400_000;
const MOVING_WINDOW_DAYS = 14;
const INSUFFICIENT = "[INSUFFICIENT DATA: Need at least 10 commits to compute Slop Velocity]";
const WEIGHTS = {
    testWeakening: 0.35,
    security: 0.3,
    slop: 0.15,
    todos: 0.1,
    churn: 0.1,
};
function clamp01(value) {
    return Math.max(0, Math.min(1, value));
}
/** Parses 30d, 2w, 3m or a plain number of days. */
export function parseHistoryWindow(raw) {
    if (raw === undefined || raw.trim() === "")
        return DEFAULT_HISTORY_DAYS;
    const match = /^(\d+(?:\.\d+)?)([dwm])?$/i.exec(raw.trim());
    if (!match?.[1])
        return DEFAULT_HISTORY_DAYS;
    const value = Number(match[1]);
    const unit = match[2]?.toLowerCase() ?? "d";
    const days = unit === "w" ? value * 7 : unit === "m" ? value * 30 : value;
    return Math.max(1, Math.min(3650, Math.round(days)));
}
function dayOf(iso) {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso.slice(0, 10) : date.toISOString().slice(0, 10);
}
function dayNumber(day) {
    const time = new Date(`${day}T00:00:00.000Z`).getTime();
    return Number.isNaN(time) ? 0 : Math.floor(time / DAY_MS);
}
function metricsOf(diff) {
    let todos = 0;
    let churn = 0;
    let sastHigh = 0;
    let sastMedium = 0;
    for (const block of splitDiffBlocks(diff)) {
        if (block.path === "(diff)" || block.path === "(unknown)")
            continue;
        const added = [];
        for (const line of block.text.split("\n")) {
            if (line.startsWith("+") && !line.startsWith("+++")) {
                added.push(line.slice(1));
                churn += 1;
                if (/\b(?:TODO|FIXME|HACK)\b/.test(line))
                    todos += 1;
            }
            else if (line.startsWith("-") && !line.startsWith("---")) {
                churn += 1;
            }
        }
        if (added.length === 0)
            continue;
        for (const finding of scanSource(block.path, added.join("\n")).findings) {
            if (finding.severity === "high")
                sastHigh += 1;
            else if (finding.severity === "medium")
                sastMedium += 1;
        }
    }
    const weakness = analyzeTestWeakness(diff).length;
    const slopProxy = Math.min(100, todos * 5 + weakness * 20 + sastHigh * 25 + sastMedium * 10 + churn / 100);
    const score = Math.round(100 *
        (WEIGHTS.testWeakening * clamp01(weakness / 3) +
            WEIGHTS.security * clamp01(sastHigh / 2 + sastMedium / 5) +
            WEIGHTS.slop * clamp01(slopProxy / 100) +
            WEIGHTS.todos * clamp01(todos / 5) +
            WEIGHTS.churn * clamp01(churn / 2000)));
    return { weakness, sastHigh, sastMedium, todos, churn, score };
}
function readCommits(cwd, sinceDays) {
    const since = new Date(Date.now() - sinceDays * DAY_MS).toISOString();
    const log = runGit(["log", `--since=${since}`, `--max-count=${String(MAX_COMMITS)}`, "--pretty=format:%H%x1f%aI"], cwd);
    if (log.status !== 0)
        return [];
    const rows = log.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
        const [hash, at] = line.split("\u001f");
        return { hash: hash ?? "", at: at ?? "" };
    })
        .filter((row) => row.hash && row.at)
        .reverse();
    const commits = [];
    for (const row of rows) {
        const diff = runGit(["show", "--format=", "--no-color", "--unified=0", row.hash], cwd);
        if (diff.status !== 0)
            continue;
        commits.push({ hash: row.hash, date: dayOf(row.at), ...metricsOf(diff.stdout) });
    }
    return commits;
}
function dailyPoints(commits) {
    const byDay = new Map();
    for (const commit of commits) {
        const entry = byDay.get(commit.date) ?? { total: 0, count: 0 };
        entry.total += commit.score;
        entry.count += 1;
        byDay.set(commit.date, entry);
    }
    return [...byDay.entries()]
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map(([date, entry]) => ({ date, score: Math.round(entry.total / entry.count), commits: entry.count }));
}
function movingAverage(points, windowDays) {
    return points.map((point, index) => {
        const current = dayNumber(point.date);
        let total = 0;
        let count = 0;
        for (let cursor = index; cursor >= 0; cursor -= 1) {
            const candidate = points[cursor];
            if (current - dayNumber(candidate.date) > windowDays)
                break;
            total += candidate.score;
            count += 1;
        }
        return { ...point, score: Math.round(total / count) };
    });
}
function withoutOutliers(points) {
    if (points.length < 4)
        return points;
    const mean = points.reduce((sum, point) => sum + point.score, 0) / points.length;
    const variance = points.reduce((sum, point) => sum + (point.score - mean) ** 2, 0) / points.length;
    const limit = mean + 2 * Math.sqrt(variance);
    const kept = points.filter((point) => point.score <= limit);
    return kept.length >= 4 ? kept : points;
}
function regress(points) {
    if (points.length < 2)
        return { slope: 0, intercept: points[0]?.score ?? 0, firstDay: points[0] ? dayNumber(points[0].date) : 0 };
    const firstDay = dayNumber(points[0].date);
    const xs = points.map((point) => dayNumber(point.date) - firstDay);
    const ys = points.map((point) => point.score);
    const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
    const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
    let covariance = 0;
    let variance = 0;
    for (let index = 0; index < xs.length; index += 1) {
        covariance += (xs[index] - meanX) * (ys[index] - meanY);
        variance += (xs[index] - meanX) ** 2;
    }
    const slope = variance === 0 ? 0 : covariance / variance;
    return { slope, intercept: meanY - slope * meanX, firstDay };
}
function escapeXml(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}
/** Self-contained SVG chart with the smoothed score and the regression line. */
export function renderBankruptcySvg(points, slope, intercept, firstDay) {
    const width = 720;
    const height = 260;
    const left = 48;
    const right = 16;
    const top = 24;
    const bottom = 36;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const first = points[0] ? dayNumber(points[0].date) : firstDay;
    const last = points.at(-1) ? dayNumber(points.at(-1).date) : first;
    const span = Math.max(1, last - first);
    const x = (day) => left + ((day - first) / span) * plotWidth;
    const y = (score) => top + (1 - Math.max(0, Math.min(100, score)) / 100) * plotHeight;
    const path = points.map((point) => `${x(dayNumber(point.date)).toFixed(1)},${y(point.score).toFixed(1)}`).join(" ");
    const trendStart = slope * 0 + intercept;
    const trendEnd = slope * span + intercept;
    const trend = `M ${left.toFixed(1)} ${y(trendStart).toFixed(1)} L ${(left + plotWidth).toFixed(1)} ${y(trendEnd).toFixed(1)}`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}" viewBox="0 0 ${String(width)} ${String(height)}" role="img" aria-label="Tech debt forecast"><title>Tech debt forecast</title><rect width="${String(width)}" height="${String(height)}" fill="#0b0f14"/><line x1="${String(left)}" y1="${String(top)}" x2="${String(left)}" y2="${String(top + plotHeight)}" stroke="#30363d"/><line x1="${String(left)}" y1="${String(top + plotHeight)}" x2="${String(left + plotWidth)}" y2="${String(top + plotHeight)}" stroke="#30363d"/><line x1="${String(left)}" y1="${String(top)}" x2="${String(left + plotWidth)}" y2="${String(top)}" stroke="#c62828" stroke-dasharray="4 4"/><text x="${String(left - 8)}" y="${String(top + 4)}" text-anchor="end" fill="#c62828" font-family="monospace" font-size="11">100</text><text x="${String(left - 8)}" y="${String(top + plotHeight + 4)}" text-anchor="end" fill="#8b949e" font-family="monospace" font-size="11">0</text><polyline points="${path}" fill="none" stroke="#58a6ff" stroke-width="2"/><path d="${trend}" fill="none" stroke="#f0883e" stroke-width="2" stroke-dasharray="6 3"/>${points[0] ? `<text x="${String(left)}" y="${String(height - 10)}" fill="#8b949e" font-family="monospace" font-size="11">${escapeXml(points[0].date)}</text>` : ""}${points.at(-1) ? `<text x="${String(left + plotWidth)}" y="${String(height - 10)}" text-anchor="end" fill="#8b949e" font-family="monospace" font-size="11">${escapeXml(points.at(-1).date)}</text>` : ""}</svg>`;
}
export function buildBankruptcy(cwd, options = {}) {
    const historyDays = Math.max(1, Math.min(3650, Math.round(options.historyDays ?? DEFAULT_HISTORY_DAYS)));
    const commits = readCommits(cwd, historyDays);
    const insufficient = commits.length < MIN_COMMITS;
    const rawPoints = dailyPoints(commits);
    const points = movingAverage(rawPoints, MOVING_WINDOW_DAYS);
    const regressionPoints = withoutOutliers(points);
    const { slope, intercept, firstDay } = regress(regressionPoints);
    const currentScore = points.at(-1)?.score ?? 0;
    const daysToBankruptcy = slope > 0.001 ? Math.max(0, Math.round((100 - intercept) / slope)) : null;
    const forecastDate = daysToBankruptcy === null
        ? null
        : new Date((firstDay + daysToBankruptcy) * DAY_MS).toISOString().slice(0, 10);
    const verdict = insufficient ? "insufficient" : forecastDate ? "forecast" : "stable";
    const lines = [];
    if (insufficient) {
        lines.push(INSUFFICIENT);
        lines.push(`Коммитов в окне ${String(historyDays)} дн.: ${String(commits.length)}.`);
    }
    else {
        lines.push(`Прогноз техдолга: ${String(commits.length)} коммитов за ${String(historyDays)} дн.`);
        lines.push(`Текущий балл: ${String(currentScore)}/100. Скорость: ${slope >= 0 ? "+" : ""}${slope.toFixed(2)}/день.`);
        if (forecastDate) {
            lines.push(`Порог 100 будет достигнут: ${forecastDate} (через ${String(daysToBankruptcy)} дн.).`);
        }
        else {
            lines.push("Скорость не положительна: в обозримом окне банкротство не прогнозируется.");
        }
    }
    if (options.explain) {
        lines.push("", "Формула: score = 100 * (0.35 * testWeakening + 0.30 * security + 0.15 * slop + 0.10 * todos + 0.10 * churn).", "testWeakening: ослабленные тесты из diff (вес 0.35), security: high/medium SAST на добавленных строках (0.30), slop: TODO + слабые тесты + SAST + churn (0.15), todos: добавленные TODO/FIXME/HACK (0.10), churn: добавленные и удалённые строки (0.10).", `Сглаживание: скользящее среднее ${String(MOVING_WINDOW_DAYS)} дн., выбросы выше mean+2σ исключены из регрессии.`);
    }
    return {
        historyDays,
        commits: commits.length,
        points,
        weights: WEIGHTS,
        slopePerDay: Number(slope.toFixed(3)),
        currentScore,
        forecastDate,
        daysToBankruptcy,
        verdict,
        insufficient,
        content: `${lines.join("\n")}\n`,
        svg: renderBankruptcySvg(points, slope, intercept, firstDay),
    };
}
//# sourceMappingURL=bankruptcy.js.map