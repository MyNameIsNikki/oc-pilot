import { issueFailsGate } from "./deps-health.js";
import { severityAtLeast as authzSeverityAtLeast } from "./authz.js";
import { severityAtLeast as sastSeverityAtLeast } from "./sast.js";
const LABELS = {
    secrets: "секреты",
    sast: "sast",
    authz: "authz",
    deps: "зависимости",
    tests: "тесты",
    slop: "slop",
    honeypot: "honeypot",
};
const MAX_DETAILS = 8;
function check(id, status, summary, details = []) {
    return { id, label: LABELS[id], status, summary, details: details.slice(0, MAX_DETAILS) };
}
function severityCounts(issues) {
    const counts = { high: 0, medium: 0, low: 0 };
    for (const issue of issues)
        counts[issue.severity] += 1;
    return `high ${counts.high}, medium ${counts.medium}, low ${counts.low}`;
}
function weaknessWord(count) {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11)
        return "ослабление тестов";
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14))
        return "ослабления тестов";
    return "ослаблений тестов";
}
/**
 * Dependency problems are repo-wide, but a preflight run is about the change
 * under review. Keep only issues that touch a changed file or a package that
 * appears in an added diff line.
 */
export function scopeDependencyIssues(issues, changedFiles, diff) {
    const changed = new Set(changedFiles.map((file) => file.replace(/\\/g, "/")));
    const added = diff
        .split("\n")
        .filter((line) => line.startsWith("+") && !line.startsWith("+++"));
    return issues.filter((issue) => {
        const files = issue.files ?? [];
        if (files.some((file) => changed.has(file.replace(/\\/g, "/"))))
            return true;
        return added.some((line) => line.includes(issue.name));
    });
}
export function buildPreflightReport(input) {
    const disabled = new Set(input.disabled ?? []);
    const checks = [];
    if (disabled.has("secrets")) {
        checks.push(check("secrets", "skip", "отключено (--no-secret-scan)"));
    }
    else if (input.secrets) {
        const critical = input.secrets.filter((finding) => finding.severity === "critical").length;
        const warnings = input.secrets.length - critical;
        if (input.secrets.length === 0) {
            checks.push(check("secrets", "pass", "секретов не найдено"));
        }
        else {
            checks.push(check("secrets", critical > 0 ? "fail" : "pass", `найдено ${String(critical)} critical и ${String(warnings)} warning`, input.secrets.map((finding) => `${finding.file}:${String(finding.line)} — ${finding.kind}`)));
        }
    }
    else {
        checks.push(check("secrets", "skip", "сканирование не выполнялось"));
    }
    if (disabled.has("sast")) {
        checks.push(check("sast", "skip", "отключено (--no-sast)"));
    }
    else if (input.sast) {
        const findings = input.sast;
        const gate = input.sastGate ?? "high";
        const high = findings.filter((finding) => finding.severity === "high").length;
        const medium = findings.filter((finding) => finding.severity === "medium").length;
        const low = findings.length - high - medium;
        checks.push(check("sast", findings.some((finding) => sastSeverityAtLeast(finding.severity, gate)) ? "fail" : "pass", findings.length === 0
            ? "опасных паттернов не найдено"
            : `${String(findings.length)} находок: high ${String(high)}, medium ${String(medium)}, low ${String(low)}`, findings.map((finding) => `${finding.severity} ${finding.rule} ${finding.file}:${String(finding.line)} — ${finding.message}`)));
    }
    else {
        checks.push(check("sast", "skip", input.sastSkip ?? "анализ не выполнялся"));
    }
    if (disabled.has("authz")) {
        checks.push(check("authz", "skip", "отключено (--no-authz)"));
    }
    else if (input.authz) {
        const findings = input.authz;
        const gate = input.authzGate ?? "high";
        const high = findings.filter((finding) => finding.severity === "high").length;
        const medium = findings.length - high;
        checks.push(check("authz", findings.some((finding) => authzSeverityAtLeast(finding.severity, gate)) ? "fail" : "pass", findings.length === 0
            ? "маршрутов без авторизации не найдено"
            : `${String(findings.length)} находок: high ${String(high)}, medium ${String(medium)}`, findings.map((finding) => `${finding.severity} ${finding.rule} ${finding.method} ${finding.route} ${finding.file}:${String(finding.line)} — ${finding.message}`)));
    }
    else {
        checks.push(check("authz", "skip", input.authzSkip ?? "анализ не выполнялся"));
    }
    if (disabled.has("deps")) {
        checks.push(check("deps", "skip", "отключено (--no-deps)"));
    }
    else if (!input.deps) {
        checks.push(check("deps", "skip", input.depsSkip ?? "package.json не найден"));
    }
    else {
        const issues = input.deps.issues;
        const gate = input.depsGate ?? "high";
        const details = issues.map((issue) => `${issue.severity} ${issue.kind} ${issue.name} — ${issue.message}`);
        if (issues.length === 0) {
            checks.push(check("deps", "pass", "проблем в изменённых файлах нет"));
        }
        else {
            checks.push(check("deps", issueFailsGate(issues, gate) ? "fail" : "pass", `${String(issues.length)} проблем(ы): ${severityCounts(issues)}`, details));
        }
    }
    if (disabled.has("tests")) {
        checks.push(check("tests", "skip", "отключено (--no-tests)"));
    }
    else if (input.weaknesses) {
        const weaknesses = input.weaknesses;
        checks.push(check("tests", weaknesses.length > 0 ? "fail" : "pass", weaknesses.length > 0
            ? `${String(weaknesses.length)} ${weaknessWord(weaknesses.length)}`
            : "ослаблений тестов не найдено", weaknesses.map((item) => `${item.file}:${String(item.line)} — ${item.detail}`)));
    }
    else {
        checks.push(check("tests", "skip", "проверка не выполнялась"));
    }
    if (disabled.has("slop")) {
        checks.push(check("slop", "skip", "отключено (--no-slop)"));
    }
    else if (!input.slop) {
        checks.push(check("slop", "skip", input.slopSkip ?? "нет базы для сравнения"));
    }
    else {
        const { report, delta } = input.slop;
        const max = input.maxSlopDelta ?? 10;
        const sign = delta.deltaPoints > 0 ? "+" : "";
        const scope = input.diff.stats.files === 0
            ? "изменённых файлов нет"
            : `индекс изменений ${String(report.index)}/100`;
        const details = delta.categories
            .filter((category) => category.introduced > 0)
            .map((category) => `${category.label}: +${String(category.introduced)}`);
        checks.push(check("slop", delta.deltaPoints > max ? "fail" : "pass", `дельта ${sign}${String(delta.deltaPoints)} пунктов (${scope})`, details));
    }
    if (disabled.has("honeypot")) {
        checks.push(check("honeypot", "skip", "отключено (--no-honeypot)"));
    }
    else if (!input.honeypot) {
        checks.push(check("honeypot", "skip", input.honeypotSkip ?? "honeypot не развёрнут"));
    }
    else if (input.honeypot.triggers.length > 0) {
        checks.push(check("honeypot", "fail", "[HONEYPOT TRIGGERED]: Agent attempted to bypass authentication using a trapped function. Session terminated. Trust score reduced.", input.honeypot.triggers.map((trigger) => `${trigger.kind} ${trigger.path}${trigger.symbol ? ` (${trigger.symbol})` : ""} — ${trigger.evidence}`)));
    }
    else {
        checks.push(check("honeypot", "pass", "ловушек не задето"));
    }
    return {
        status: checks.some((item) => item.status === "fail") ? "fail" : "pass",
        checks,
        diff: {
            source: input.diff.source,
            files: input.diff.stats.files,
            additions: input.diff.stats.additions,
            deletions: input.diff.stats.deletions,
        },
    };
}
/** Human-readable report for the terminal. */
export function renderPreflight(report) {
    const lines = [];
    const width = Math.max(...report.checks.map((item) => item.id.length));
    for (const item of report.checks) {
        const mark = item.status === "pass" ? "OK  " : item.status === "fail" ? "FAIL" : "SKIP";
        lines.push(`${mark}  ${item.id.padEnd(width)}  ${item.summary}`);
        for (const detail of item.details)
            lines.push(`      ${detail}`);
    }
    const failed = report.checks.filter((item) => item.status === "fail").length;
    lines.push("");
    lines.push(failed === 0
        ? `Preflight пройден: ${String(report.checks.length)} проверок, замечаний нет.`
        : `Preflight не пройден: ${String(failed)} из ${String(report.checks.length)} проверок.`);
    return `${lines.join("\n")}\n`;
}
//# sourceMappingURL=preflight.js.map