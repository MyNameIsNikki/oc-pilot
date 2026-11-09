import { addQuarantine, checkQuarantine, clearQuarantine, listQuarantine, removeQuarantine, } from "../core/quarantine.js";
import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString, parsePositiveInt } from "../core/parse.js";
const OPTIONS = withCommon({
    test: { type: "string" },
    owner: { type: "string" },
    reason: { type: "string" },
    days: { type: "string" },
    issue: { type: "string" },
    force: { type: "boolean" },
});
const HELP = `Использование:
  oc-pilot quarantine add --test <name> --owner <name> --reason <text> [--days 14]
  oc-pilot quarantine list
  oc-pilot quarantine check
  oc-pilot quarantine remove --test <name>
  oc-pilot quarantine clear --force

Карантин хранит флейки с владельцем и сроком в .oc-pilot/quarantine.json.
check падает с [QUARANTINE EXPIRED], когда срок истёк, чтобы подавление
не стало вечным. Модель и сеть не используются.

Опции:
      --test <name>     имя теста
      --owner <name>    кто отвечает
      --reason <text>   почему тест на карантине
      --days <14>       срок в днях (1–365)
      --issue <url>     ссылка на issue
      --force           подтвердить clear
${COMMON_HELP}

Коды выхода:
  0  карантин в порядке или пуст
  1  [QUARANTINE EXPIRED] или remove не нашёл тест
  2  ошибка аргументов

Примеры:
  oc-pilot quarantine add --test "auth flow" --owner alice --reason "race" --days 14
  oc-pilot quarantine check
  oc-pilot quarantine list --json`;
export async function runQuarantine(argv) {
    const { values, positionals } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(`${HELP}\n`);
        return 0;
    }
    const [subcommand] = positionals;
    const ctx = resolveContext(values);
    if (subcommand === "add") {
        const test = asString(values, "test");
        const owner = asString(values, "owner");
        const reason = asString(values, "reason");
        if (!test || !owner || !reason) {
            throw new PilotError("Нужны --test, --owner и --reason", {
                hint: "Например: --test \"auth flow\" --owner alice --reason \"race\".",
                exitCode: 2,
            });
        }
        const daysRaw = asString(values, "days");
        const entry = addQuarantine(ctx.cwd, {
            test,
            owner,
            reason,
            days: daysRaw ? parsePositiveInt(daysRaw, "days", 365) : 14,
            issue: asString(values, "issue"),
        });
        if (ctx.flags.json)
            writeOutput(JSON.stringify(entry, null, 2), ctx.flags.output);
        else
            process.stdout.write(`Quarantine: ${entry.test} до ${entry.expiresAt} (owner ${entry.owner}).\n`);
        return 0;
    }
    if (subcommand === "list") {
        const report = listQuarantine(ctx.cwd);
        const wrote = ctx.flags.json
            ? writeOutput(JSON.stringify(report, null, 2), ctx.flags.output)
            : writeOutput(report.content, ctx.flags.output);
        if (wrote)
            log.success(`Результат сохранён: ${wrote}`);
        return 0;
    }
    if (subcommand === "check") {
        const report = checkQuarantine(ctx.cwd);
        const wrote = ctx.flags.json
            ? writeOutput(JSON.stringify(report, null, 2), ctx.flags.output)
            : writeOutput(report.content, ctx.flags.output);
        if (wrote)
            log.success(`Результат сохранён: ${wrote}`);
        if (report.status === "expired") {
            log.error(report.summary);
            return 1;
        }
        log.info(report.summary);
        return 0;
    }
    if (subcommand === "remove") {
        const test = asString(values, "test");
        if (!test) {
            throw new PilotError("Укажите --test", {
                hint: "Список: oc-pilot quarantine list.",
                exitCode: 2,
            });
        }
        const result = removeQuarantine(ctx.cwd, test);
        if (!result.removed) {
            log.warn(`Тест не найден на карантине: ${test}`);
            return 1;
        }
        if (ctx.flags.json)
            writeOutput(JSON.stringify(result, null, 2), ctx.flags.output);
        else
            process.stdout.write(`Quarantine: снято 1, осталось ${String(result.remaining)}.\n`);
        return 0;
    }
    if (subcommand === "clear") {
        if (!asBoolean(values, "force")) {
            throw new PilotError("clear удаляет весь карантин; добавьте --force", {
                hint: "Проверить: oc-pilot quarantine list.",
                exitCode: 2,
            });
        }
        const result = clearQuarantine(ctx.cwd);
        if (ctx.flags.json)
            writeOutput(JSON.stringify(result, null, 2), ctx.flags.output);
        else
            process.stdout.write(`Quarantine: удалено ${String(result.removed)}.\n`);
        return 0;
    }
    throw new PilotError("Неизвестная подкоманда quarantine", {
        hint: "Доступно: add, list, check, remove, clear.",
        exitCode: 2,
    });
}
//# sourceMappingURL=quarantine.js.map