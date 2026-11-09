import { bisectMayday, renderMaydayBisect, renderMaydayRollback, rollbackMayday, } from "../core/mayday.js";
import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString, parsePositiveInt, parseSeconds } from "../core/parse.js";
import { detectTestCommand } from "../core/project.js";
const OPTIONS = withCommon({
    good: { type: "string" },
    bad: { type: "string" },
    to: { type: "string" },
    command: { type: "string" },
    "test-command": { type: "string" },
    "test-timeout": { type: "string" },
    "max-steps": { type: "string" },
    branch: { type: "string" },
    confirm: { type: "boolean" },
    force: { type: "boolean" },
    "no-test": { type: "boolean" },
});
const HELP = `Использование:
  oc-pilot mayday bisect --good <ref> [--bad HEAD] [--command <cmd>]
  oc-pilot mayday rollback --to <ref> --confirm [опции]

bisect ищет первый коммит, на котором команда начинает падать, двоичным
поиском по истории в теневых worktree. rollback откатывает всё после --to
через git revert в shadow worktree, по желанию прогоняет тесты и оставляет
ветку для ревью; reset --hard и force-push не используются.

Статусы bisect:
  [MAYDAY FOUND]  первый плохой коммит найден
  [MAYDAY NONE]   падений в диапазоне нет
Статусы rollback:
  [MAYDAY ROLLBACK READY]   откат создан и тесты прошли
  [MAYDAY ROLLBACK FAILED]  откат создан, но тесты не прошли

Опции:
      --good <ref>          последний хороший коммит (bisect)
      --bad <ref>           плохой коммит (по умолчанию HEAD)
      --to <ref>            куда откатываться (rollback)
      --command <cmd>       команда проверки для bisect
      --test-command <cmd>  команда тестов для rollback
      --test-timeout <120s> таймаут одного прогона
      --max-steps <24>      максимум шагов bisect
      --branch <name>       имя rollback-ветки
      --confirm             подтвердить создание rollback-ветки
      --force               перезаписать существующую ветку
      --no-test             не запускать тесты при rollback
${COMMON_HELP}

Коды выхода:
  0  bisect нашёл коммит / rollback готов
  1  bisect не нашёл / rollback не прошёл тесты
  2  ошибка git или запуска

Примеры:
  oc-pilot mayday bisect --good v1.2.0 --bad HEAD --command "npm test"
  oc-pilot mayday rollback --to v1.2.0 --confirm --test-command "npm test"`;
export async function runMayday(argv) {
    const { values, positionals } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(`${HELP}\n`);
        return 0;
    }
    const [subcommand] = positionals;
    const ctx = resolveContext(values);
    const timeoutRaw = asString(values, "test-timeout");
    const timeoutMs = timeoutRaw ? parseSeconds(timeoutRaw, "test-timeout") * 1000 : undefined;
    if (subcommand === "bisect") {
        const good = asString(values, "good");
        if (!good) {
            throw new PilotError("Нужен последний хороший коммит", {
                hint: "Передайте --good <ref>.",
                exitCode: 2,
            });
        }
        const bad = asString(values, "bad") ?? "HEAD";
        const command = asString(values, "command") ?? detectTestCommand(ctx.cwd)?.command;
        if (!command) {
            throw new PilotError("Не удалось определить команду проверки", {
                hint: "Передайте --command, например \"npm test\".",
                exitCode: 2,
            });
        }
        const maxStepsRaw = asString(values, "max-steps");
        const result = await bisectMayday(ctx.cwd, good, bad, {
            command,
            timeoutMs,
            maxSteps: maxStepsRaw ? parsePositiveInt(maxStepsRaw, "max-steps", 64) : undefined,
        });
        const wrote = ctx.flags.json
            ? writeOutput(JSON.stringify(result, null, 2), ctx.flags.output)
            : writeOutput(renderMaydayBisect(result), ctx.flags.output);
        if (wrote)
            log.success(`Результат сохранён: ${wrote}`);
        if (result.status === "found") {
            log.error(result.summary);
            return 0;
        }
        if (result.status === "none") {
            log.warn(result.summary);
            return 1;
        }
        log.error(result.summary);
        return 2;
    }
    if (subcommand === "rollback") {
        const to = asString(values, "to");
        if (!to) {
            throw new PilotError("Нужен целевой коммит отката", {
                hint: "Передайте --to <ref>.",
                exitCode: 2,
            });
        }
        if (!asBoolean(values, "confirm")) {
            throw new PilotError("rollback создаёт ветку; добавьте --confirm", {
                hint: "Сначала найдите первый плохой коммит: oc-pilot mayday bisect.",
                exitCode: 2,
            });
        }
        const noTest = asBoolean(values, "no-test");
        const testCommand = noTest
            ? undefined
            : (asString(values, "test-command") ?? detectTestCommand(ctx.cwd)?.command);
        const result = await rollbackMayday(ctx.cwd, to, {
            testCommand,
            timeoutMs,
            runTests: !noTest,
            branch: asString(values, "branch"),
            force: asBoolean(values, "force"),
        });
        const wrote = ctx.flags.json
            ? writeOutput(JSON.stringify(result, null, 2), ctx.flags.output)
            : writeOutput(renderMaydayRollback(result), ctx.flags.output);
        if (wrote)
            log.success(`Результат сохранён: ${wrote}`);
        if (result.status === "ready") {
            log.success(result.summary);
            return 0;
        }
        if (result.status === "none") {
            log.info(result.summary);
            return 0;
        }
        log.error(result.summary);
        return 1;
    }
    throw new PilotError("Неизвестная подкоманда mayday", {
        hint: "Доступно: bisect, rollback.",
        exitCode: 2,
    });
}
//# sourceMappingURL=mayday.js.map