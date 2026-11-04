import { auditDependencies, issueFailsGate } from "../core/deps-health.js";
import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";
const OPTIONS = withCommon({
    "fail-on-issue": { type: "string" },
    ignore: { type: "string" },
});
const HELP = `Использование:
  oc-pilot deps [опции]

Офлайн-аудит зависимостей npm-проекта. Находит импорты пакетов, которых нет
в package.json (чистая установка упадёт), объявленные но неиспользуемые
пакеты, зависимости только для тестов в dependencies, дубли по назначению,
небезопасные спецификации версий и рассинхрон с package-lock.json.
Сеть не используется, модель не вызывается.

Опции:
      --fail-on-issue <level>  код 1 при проблеме уровня high, medium или low
      --ignore <names>         не проверять пакеты (через запятую)
${COMMON_HELP}

Примеры:
  oc-pilot deps
  oc-pilot deps --json
  oc-pilot deps --fail-on-issue high
  oc-pilot deps --ignore lint-staged`;
const SEVERITIES = new Set(["high", "medium", "low"]);
function parseSeverity(value) {
    const normalized = value.trim().toLowerCase();
    if (!SEVERITIES.has(normalized)) {
        throw new PilotError(`Некорректный --fail-on-issue: ${value}`, {
            hint: "Допустимые значения: high, medium, low",
            exitCode: 2,
        });
    }
    return normalized;
}
function renderIssue(issue) {
    const files = issue.files && issue.files.length > 0 ? ` [${issue.files.join(", ")}]` : "";
    return `${issue.severity.toUpperCase().padEnd(6)} ${issue.kind.padEnd(9)} ${issue.name} — ${issue.message}${files}`;
}
export async function runDeps(argv) {
    const { values } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(HELP);
        return 0;
    }
    const ctx = resolveContext(values);
    const ignoreRaw = asString(values, "ignore");
    const ignore = ignoreRaw
        ? ignoreRaw
            .split(",")
            .map((name) => name.trim())
            .filter(Boolean)
        : [];
    const gateRaw = asString(values, "fail-on-issue");
    const gate = gateRaw ? parseSeverity(gateRaw) : undefined;
    const report = auditDependencies(ctx.cwd, { ignore });
    const failed = gate !== undefined && issueFailsGate(report.issues, gate);
    if (ctx.flags.json) {
        writeOutput(JSON.stringify(report, null, 2), ctx.flags.output);
        return failed ? 1 : 0;
    }
    log.info(`Зависимости ${report.packageName}: объявлено ${report.declared}, импортируется ${report.imported}, файлов ${report.scannedFiles}.`);
    if (report.truncated)
        log.warn("Список файлов обрезан: проверены не все исходники.");
    if (report.issues.length === 0) {
        const wrote = writeOutput("Проблем не найдено.\n", ctx.flags.output);
        if (wrote)
            log.success(`Отчёт сохранён: ${wrote}`);
        else
            log.success("Проблем не найдено.");
        return 0;
    }
    const lines = report.issues.map(renderIssue);
    const counts = {
        high: report.issues.filter((issue) => issue.severity === "high").length,
        medium: report.issues.filter((issue) => issue.severity === "medium").length,
        low: report.issues.filter((issue) => issue.severity === "low").length,
    };
    lines.push("");
    lines.push(`Итог: high ${counts.high}, medium ${counts.medium}, low ${counts.low}.`);
    const body = `${lines.join("\n")}\n`;
    const wrote = writeOutput(body, ctx.flags.output);
    if (wrote) {
        log.success(`Отчёт сохранён: ${wrote}`);
    }
    else {
        for (const issue of report.issues) {
            if (issue.severity === "high")
                log.warn(`${issue.kind}: ${issue.name}`);
            else
                log.detail(`${issue.kind}: ${issue.name}`);
        }
    }
    if (failed)
        log.error(`Есть проблемы уровня ${gate} или выше.`);
    return failed ? 1 : 0;
}
//# sourceMappingURL=deps.js.map