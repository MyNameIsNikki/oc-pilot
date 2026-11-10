import { clearMirage, listCassettes, miragePath, readCassette, runMirage, } from "../core/mirage.js";
import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString, parseSeconds } from "../core/parse.js";
const OPTIONS = withCommon({
    command: { type: "string" },
    cassette: { type: "string" },
    timeout: { type: "string" },
    force: { type: "boolean" },
});
const HELP = `Использование:
  oc-pilot mirage record --command "node test.mjs" --cassette cassettes/x.json
  oc-pilot mirage replay --command "node test.mjs" --cassette cassettes/x.json
  oc-pilot mirage list
  oc-pilot mirage show --cassette cassettes/x.json
  oc-pilot mirage clear --force

Запускает команду с preload, который записывает fetch-ответы и Date.now
в кассету, а затем воспроизводит их без сети. replay падает с
[MIRAGE MISS], если команда запросила незаписанный URL.
Модель не используется.

Опции:
      --command <cmd>      команда для записи или воспроизведения
      --cassette <file>    путь к кассете (JSON)
      --timeout <300s>     таймаут команды
      --force              подтвердить clear
${COMMON_HELP}

Коды выхода:
  0  запись или воспроизведение прошли
  1  [MIRAGE MISS] при replay
  2  ошибка команды или кассеты

Примеры:
  oc-pilot mirage record --command "node test.mjs" --cassette cassettes/login.json
  oc-pilot mirage replay --command "node test.mjs" --cassette cassettes/login.json
  oc-pilot mirage list --json`;
export async function runMirageCommand(argv) {
    const { values, positionals } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(`${HELP}\n`);
        return 0;
    }
    const [subcommand] = positionals;
    const ctx = resolveContext(values);
    if (subcommand === "record" || subcommand === "replay") {
        const command = asString(values, "command");
        const cassette = asString(values, "cassette");
        if (!command || !cassette) {
            throw new PilotError("Нужны --command и --cassette", {
                hint: "Например: --command \"node test.mjs\" --cassette cassettes/login.json.",
                exitCode: 2,
            });
        }
        const timeoutRaw = asString(values, "timeout");
        const report = await runMirage(ctx.cwd, {
            mode: subcommand,
            command,
            cassette,
            timeoutMs: timeoutRaw ? parseSeconds(timeoutRaw, "timeout") * 1000 : undefined,
        });
        const wrote = ctx.flags.json
            ? writeOutput(JSON.stringify(report, null, 2), ctx.flags.output)
            : writeOutput(report.content, ctx.flags.output);
        if (wrote)
            log.success(`Результат сохранён: ${wrote}`);
        if (report.status === "ok") {
            log.success(report.summary);
            return 0;
        }
        if (report.status === "miss") {
            log.error(report.summary);
            return 1;
        }
        log.error(report.summary);
        return 2;
    }
    if (subcommand === "list") {
        const cassettes = listCassettes(ctx.cwd);
        if (ctx.flags.json) {
            writeOutput(JSON.stringify(cassettes, null, 2), ctx.flags.output);
            return 0;
        }
        if (cassettes.length === 0) {
            log.info("Кассет нет.");
            return 0;
        }
        const lines = [`Cassettes: ${String(cassettes.length)}.`];
        for (const cassette of cassettes) {
            lines.push(`  ${cassette.file} — ${String(cassette.entries)} fetch, ${String(cassette.clock)} clock`);
        }
        process.stdout.write(`${lines.join("\n")}\n`);
        return 0;
    }
    if (subcommand === "show") {
        const cassette = asString(values, "cassette");
        if (!cassette) {
            throw new PilotError("Укажите --cassette", { exitCode: 2 });
        }
        const data = readCassette(miragePath(ctx.cwd, cassette));
        if (!data) {
            throw new PilotError(`Кассета не найдена: ${cassette}`, { exitCode: 2 });
        }
        if (ctx.flags.json) {
            writeOutput(JSON.stringify(data, null, 2), ctx.flags.output);
            return 0;
        }
        const lines = [
            `Cassette: ${cassette}`,
            `Created: ${data.createdAt}`,
            `Entries: ${String(data.entries.length)}, clock: ${String(data.clock.length)}`,
        ];
        for (const entry of data.entries) {
            lines.push(`  ${entry.method} ${entry.url} -> ${String(entry.status)}, ${String(entry.body.length)} bytes`);
        }
        process.stdout.write(`${lines.join("\n")}\n`);
        return 0;
    }
    if (subcommand === "clear") {
        if (!asBoolean(values, "force")) {
            throw new PilotError("clear удаляет все кассеты; добавьте --force", { exitCode: 2 });
        }
        const result = clearMirage(ctx.cwd);
        if (ctx.flags.json)
            writeOutput(JSON.stringify(result, null, 2), ctx.flags.output);
        else
            process.stdout.write(`Mirage: удалено ${String(result.removed)}.\n`);
        return 0;
    }
    throw new PilotError("Неизвестная подкоманда mirage", {
        hint: "Доступно: record, replay, list, show, clear.",
        exitCode: 2,
    });
}
//# sourceMappingURL=mirage.js.map