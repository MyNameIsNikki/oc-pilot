import { PilotError } from "../core/errors.js";
import { fixInjection, parseInjectionSeverity, renderInjection, scanInjection, severityAtLeast } from "../core/injection.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";
const OPTIONS = withCommon({
    fix: { type: "boolean" },
    "fail-on": { type: "string" },
    include: { type: "string" },
    exclude: { type: "string" },
    "max-files": { type: "string" },
});
const HELP = `Использование:
  oc-pilot injection [опции]

Сканирует текст, который читает ИИ-агент: README, docs, комментарии,
HTML, JSON, YAML и исходники. Ищет скрытые инструкции, попытки
перехвата роли, exfiltration через markdown-картинки, невидимые
Unicode-символы, CSS-спрятанный текст и base64-полезную нагрузку.
Модель и сеть не используются.

Опции:
      --fail-on <high|medium|low>  порог exit 1 (по умолчанию high)
      --fix                        удалить невидимые Unicode-символы
      --include <glob>             сканировать только совпавшие пути
      --exclude <glob>             исключить пути
      --max-files <n>              лимит файлов (по умолчанию 3000)
${COMMON_HELP}

Примеры:
  oc-pilot injection
  oc-pilot injection --fail-on medium
  oc-pilot injection --fix --include "docs/**"`;
function parseMaxFiles(raw) {
    if (raw === undefined || raw.trim() === "")
        return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 1) {
        throw new PilotError(`Некорректный лимит файлов: ${raw}`, { hint: "Используйте положительное число.", exitCode: 2 });
    }
    return Math.floor(value);
}
export async function runInjection(argv) {
    const { values } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(HELP);
        return 0;
    }
    const ctx = resolveContext(values);
    const options = {
        include: asString(values, "include") ? [asString(values, "include")] : undefined,
        exclude: asString(values, "exclude") ? [asString(values, "exclude")] : undefined,
        maxFiles: parseMaxFiles(asString(values, "max-files")),
    };
    const threshold = parseInjectionSeverity(asString(values, "fail-on"));
    if (asBoolean(values, "fix")) {
        const fixed = fixInjection(ctx.cwd, options);
        log.success(`Очищено файлов: ${String(fixed.files)}, удалено символов: ${String(fixed.removed)}.`);
    }
    const report = scanInjection(ctx.cwd, options);
    if (ctx.flags.json) {
        const wrote = writeOutput(JSON.stringify(report, null, 2), ctx.flags.output);
        if (wrote)
            log.success(`Отчёт сохранён: ${wrote}`);
    }
    else {
        const wrote = writeOutput(renderInjection(report), ctx.flags.output);
        if (wrote)
            log.success(`Отчёт сохранён: ${wrote}`);
    }
    const failed = report.findings.some((finding) => severityAtLeast(finding.severity, threshold));
    if (failed)
        log.error(report.summary);
    return failed ? 1 : 0;
}
//# sourceMappingURL=injection.js.map