import { applyApoptosis, renderApoptosis, scanApoptosis } from "../core/apoptosis.js";
import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";
import { detectTestCommand } from "../core/project.js";
const OPTIONS = withCommon({
    command: { type: "string" },
    timeout: { type: "string" },
    confirm: { type: "boolean" },
    "fail-on-senescent": { type: "boolean" },
});
const HELP = `Использование:
  oc-pilot apoptosis scan [опции]
  oc-pilot apoptosis apply --confirm [опции]

Ищет функции с маркером /* @lifespan: 30d */. Если маркер старше
указанного срока и на функцию больше нет ссылок, она получает статус
[Senescent]. \`apply\` комментирует такие функции в отдельном git
worktree, запускает тесты и переносит diff в рабочий проект только
при зелёном прогоне. Без --confirm apply не работает.

Опции:
      --command <cmd>        тестовая команда (по умолчанию из проекта)
      --timeout <120s>       таймаут тестов
      --confirm              подтвердить удаление сенесцентных функций
      --fail-on-senescent    exit 1, если scan нашёл сенесцентные функции
${COMMON_HELP}

Примеры:
  oc-pilot apoptosis scan
  oc-pilot apoptosis scan --fail-on-senescent
  oc-pilot apoptosis apply --confirm --command "npm test"`;
function parseTimeout(raw) {
    if (raw === undefined || raw.trim() === "")
        return undefined;
    const match = /^(\d+(?:\.\d+)?)(ms|s)?$/i.exec(raw.trim());
    if (!match?.[1])
        throw new PilotError(`Некорректный таймаут: ${raw}`, { hint: "Используйте 120s или 5000ms.", exitCode: 2 });
    const value = Number(match[1]);
    return Math.round(match[2]?.toLowerCase() === "ms" ? value : value * 1000);
}
export async function runApoptosis(argv) {
    const { values, positionals } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(HELP);
        return 0;
    }
    const action = positionals[0] ?? "scan";
    const ctx = resolveContext(values);
    if (action === "scan") {
        const report = scanApoptosis(ctx.cwd);
        if (ctx.flags.json) {
            const wrote = writeOutput(JSON.stringify(report, null, 2), ctx.flags.output);
            if (wrote)
                log.success(`Отчёт сохранён: ${wrote}`);
        }
        else {
            const wrote = writeOutput(renderApoptosis(report), ctx.flags.output);
            if (wrote)
                log.success(`Отчёт сохранён: ${wrote}`);
        }
        if (report.senescent > 0)
            log.warn(report.summary);
        return asBoolean(values, "fail-on-senescent") && report.senescent > 0 ? 1 : 0;
    }
    if (action === "apply") {
        if (!asBoolean(values, "confirm")) {
            throw new PilotError("apoptosis apply требует --confirm", {
                hint: "Сначала посмотрите отчёт scan, затем повторите с --confirm.",
                exitCode: 2,
            });
        }
        const command = asString(values, "command") ?? ctx.config.testCommand ?? detectTestCommand(ctx.cwd)?.command;
        if (!command) {
            throw new PilotError("Не найдена тестовая команда для apoptosis apply", {
                hint: "Укажите --command или поле testCommand в .oc-pilot.json.",
                exitCode: 2,
            });
        }
        const result = await applyApoptosis(ctx.cwd, {
            command,
            timeoutMs: parseTimeout(asString(values, "timeout")),
            confirm: true,
        });
        if (ctx.flags.json) {
            const wrote = writeOutput(JSON.stringify(result, null, 2), ctx.flags.output);
            if (wrote)
                log.success(`Отчёт сохранён: ${wrote}`);
        }
        else {
            const wrote = writeOutput(`${result.summary}\n`, ctx.flags.output);
            if (wrote)
                log.success(`Отчёт сохранён: ${wrote}`);
        }
        if (result.status === "applied" || result.status === "nothing")
            return 0;
        log.error(result.summary);
        return 1;
    }
    throw new PilotError(`Неизвестная подкоманда apoptosis: ${action}`, {
        hint: "Доступно: scan, apply.",
        exitCode: 2,
    });
}
//# sourceMappingURL=apoptosis.js.map