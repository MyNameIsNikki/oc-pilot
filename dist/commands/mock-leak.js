import { loadDiff } from "../core/diff-source.js";
import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { analyzeMockLeaks, describeMockLeaks } from "../core/mock-leak.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";
const OPTIONS = withCommon({
    diff: { type: "string" },
    staged: { type: "boolean" },
    unstaged: { type: "boolean" },
    base: { type: "string" },
    "include-untracked": { type: "boolean" },
    "fail-on-leak": { type: "string" },
});
const HELP = `Использование:
  oc-pilot mock-leak [пути] [опции]

Ищет забытые заглушки и хардкод в изменённом прод-коде: локальные пути
(C:/Users/..., /home/...), тестовые токены, условия if (true) и if (false),
имена вида mockUser, комментарии про mock/stub и localhost-адреса.
Тестовые, сгенерированные файлы и документация пропускаются.

Опции:
      --fail-on-leak <high|medium|low>  код 1 при находке этого уровня или выше
      --diff <file>                готовый unified diff вместо git-состояния
      --staged                     взять staged-изменения
      --unstaged                   взять unstaged-изменения
      --base <ref>                 дифф <ref>...HEAD
      --include-untracked          включить неотслеживаемые файлы
${COMMON_HELP}

Примеры:
  oc-pilot mock-leak --staged
  oc-pilot mock-leak --base main --fail-on-leak high
  oc-pilot mock-leak --diff changes.diff --json`;
const RANK = { low: 1, medium: 2, high: 3 };
function parseSeverity(raw) {
    if (raw === "low" || raw === "medium" || raw === "high")
        return raw;
    throw new PilotError(`Неизвестный уровень --fail-on-leak: ${raw}`, {
        hint: "Допустимые значения: high, medium, low.",
        exitCode: 2,
    });
}
function renderMockLeaks(source, report) {
    const lines = [
        `Источник: ${source}`,
        `Найдено заглушек и хардкода: ${String(report.counts.total)}.`,
    ];
    if (report.counts.total === 0) {
        lines.push("Изменённый прод-код чистый.");
    }
    else {
        lines.push(`По уровням: high ${String(report.counts.high)}, medium ${String(report.counts.medium)}, low ${String(report.counts.low)}.`);
        lines.push("", describeMockLeaks(report.findings));
    }
    return `${lines.join("\n")}\n`;
}
export async function runMockLeak(argv) {
    const { values, positionals } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(HELP);
        return 0;
    }
    const failOnRaw = asString(values, "fail-on-leak");
    const failOn = failOnRaw ? parseSeverity(failOnRaw) : undefined;
    const ctx = resolveContext(values);
    const data = await loadDiff(values, ctx, positionals);
    if (!data.diff.trim()) {
        log.info("Изменений нет — искать заглушки негде.");
        return 0;
    }
    const report = analyzeMockLeaks(data.diff);
    const failed = failOn !== undefined && report.findings.some((finding) => RANK[finding.severity] >= RANK[failOn]);
    const gate = { failOn, passed: !failed };
    if (ctx.flags.json) {
        const payload = { source: data.source, ...report, gate };
        const wrote = writeOutput(JSON.stringify(payload, null, 2), ctx.flags.output);
        if (wrote)
            log.success(`Отчёт сохранён: ${wrote}`);
        if (failed)
            log.error(`Найдены заглушки уровня ${failOn} или выше.`);
        return failed ? 1 : 0;
    }
    const wrote = writeOutput(renderMockLeaks(data.source, report), ctx.flags.output);
    if (wrote)
        log.success(`Отчёт сохранён: ${wrote}`);
    if (report.counts.total > 0) {
        log.warn(`Заглушки и хардкод: ${String(report.counts.total)}. Проверьте, что это не уйдёт в прод.`);
    }
    if (failed) {
        log.error(`Найдены заглушки уровня ${failOn} или выше.`);
    }
    return failed ? 1 : 0;
}
//# sourceMappingURL=mock-leak.js.map