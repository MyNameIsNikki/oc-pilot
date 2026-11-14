import { PilotError } from "../core/errors.js";
import { bisectFlight, compareFlights, createCheckpoint, diffFlight, endFlight, execInFlight, exportFlight, flightStats, flightStatus, listFlights, renderFlightBisect, renderFlightCheckpoint, renderFlightCompare, renderFlightDiff, renderFlightEnd, renderFlightExec, renderFlightExport, renderFlightHtml, renderFlightList, renderFlightReplay, renderFlightShow, renderFlightStart, renderFlightStats, renderFlightStatus, renderFlightVerify, replayFlight, showFlight, startFlight, } from "../core/flight.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";
const OPTIONS = withCommon({
    name: { type: "string" },
    label: { type: "string" },
    timeout: { type: "string" },
    id: { type: "string" },
    with: { type: "string" },
    to: { type: "string" },
    from: { type: "string" },
    path: { type: "string" },
});
const HELP = `Использование:
  oc-pilot flight start [--name <имя>]
  oc-pilot flight exec [--timeout <мс>] -- <команда...>
  oc-pilot flight checkpoint [--label <метка>]
  oc-pilot flight status
  oc-pilot flight stats
  oc-pilot flight list
  oc-pilot flight show <id>
  oc-pilot flight replay [--to <метка|commit>] [--id <id>] [--path <путь>]
  oc-pilot flight bisect [--id <id>] [--timeout <мс>] -- <команда...>
  oc-pilot flight diff [--from <метка|commit>] [--to <метка|commit>] [--id <id>]
  oc-pilot flight compare <id-a> <id-b>
  oc-pilot flight html [--id <id>] [--output <файл>]
  oc-pilot flight export [--id <id>] [--output <файл>]
  oc-pilot flight end
  oc-pilot flight verify <id>

Чёрный ящик агентской сессии: журнал событий с хеш-цепочкой и
чекпоинтами рабочего дерева. Журнал лежит в .git/oc-pilot/flights/<id>.

Опции:
      --name <имя>          имя полёта для start
      --label <метка>       метка чекпоинта
      --timeout <мс>        таймаут команды для exec/bisect (по умолчанию 600000)
      --id <id>             идентификатор полёта
      --with <id>           второй полёт для compare
      --to <ref>            чекпоинт для replay/diff: метка или commit
      --from <ref>          начальный чекпоинт для diff
      --path <путь>         каталог для replay-worktree
${COMMON_HELP}
Коды возврата:
  0  успех
  1  ошибка, команда exec/bisect завершилась с ненулевым кодом
  2  полёт не запущен или журнал повреждён

Примеры:
  oc-pilot flight start --name "fix auth"
  oc-pilot flight stats
  oc-pilot flight exec -- npm test
  oc-pilot flight checkpoint --label "tests green"
  oc-pilot flight replay --to "tests green"
  oc-pilot flight bisect -- node --test
  oc-pilot flight diff --from base --to "tests green"
  oc-pilot flight compare 20261114T120000-ab12cd 20261114T130000-cd34ef
  oc-pilot flight html --output flight.html
  oc-pilot flight export --output flight.json
  oc-pilot flight verify 20261114T120000-ab12cd`;
function requireId(values, positionals) {
    const id = asString(values, "id") ?? positionals[1];
    if (!id) {
        throw new PilotError("Не указан идентификатор полёта.", {
            hint: "Посмотрите список: oc-pilot flight list.",
        });
    }
    return id;
}
function timeoutOf(values) {
    const raw = asString(values, "timeout");
    if (raw === undefined)
        return 600_000;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
        throw new PilotError(`Некорректный таймаут: ${raw}`, {
            hint: "Укажите положительное целое число миллисекунд.",
        });
    }
    return value;
}
export function runFlight(argv) {
    let args = [...argv];
    let explicitCommand;
    if (args[0] === "exec" || args[0] === "bisect") {
        const separator = args.indexOf("--");
        if (separator >= 0) {
            explicitCommand = args.slice(separator + 1);
            args = args.slice(0, separator);
        }
    }
    const { values, positionals } = parseCommandArgs(args, OPTIONS);
    const action = positionals[0] ?? "status";
    if (asBoolean(values, "help") || action === "help") {
        writeOutput(HELP);
        return 0;
    }
    const ctx = resolveContext(values);
    const json = ctx.flags.json === true;
    if (action === "start") {
        const name = asString(values, "name") ?? "flight";
        const session = startFlight(ctx.cwd, name);
        writeOutput(json ? JSON.stringify({ active: true, session }, null, 2) : renderFlightStart(session), ctx.flags.output);
        log.success(`Полёт ${session.meta.id} начат.`);
        return 0;
    }
    if (action === "exec") {
        const command = explicitCommand ?? positionals.slice(1);
        const result = execInFlight(ctx.cwd, command, {
            timeoutMs: timeoutOf(values),
            quiet: json,
        });
        writeOutput(json ? JSON.stringify(result, null, 2) : renderFlightExec(result), ctx.flags.output);
        if (result.timedOut)
            return 124;
        return result.exitCode ?? 1;
    }
    if (action === "checkpoint") {
        const label = asString(values, "label") ?? new Date().toISOString();
        const checkpoint = createCheckpoint(ctx.cwd, label);
        writeOutput(json ? JSON.stringify(checkpoint, null, 2) : renderFlightCheckpoint(checkpoint), ctx.flags.output);
        log.success(`Чекпоинт ${checkpoint.label} записан.`);
        return 0;
    }
    if (action === "status") {
        const status = flightStatus(ctx.cwd);
        writeOutput(json ? JSON.stringify(status, null, 2) : renderFlightStatus(status), ctx.flags.output);
        return status.active ? 0 : 2;
    }
    if (action === "stats") {
        const stats = flightStats(ctx.cwd);
        writeOutput(json ? JSON.stringify(stats, null, 2) : renderFlightStats(stats), ctx.flags.output);
        return 0;
    }
    if (action === "list") {
        const flights = listFlights(ctx.cwd);
        writeOutput(json ? JSON.stringify({ flights }, null, 2) : renderFlightList(flights), ctx.flags.output);
        return 0;
    }
    if (action === "show") {
        const show = showFlight(ctx.cwd, requireId(values, positionals));
        writeOutput(json ? JSON.stringify(show, null, 2) : renderFlightShow(show), ctx.flags.output);
        return show.verification.valid ? 0 : 2;
    }
    if (action === "verify") {
        const show = showFlight(ctx.cwd, requireId(values, positionals));
        writeOutput(json
            ? JSON.stringify({ id: show.meta.id, ...show.verification }, null, 2)
            : renderFlightVerify(show.verification), ctx.flags.output);
        return show.verification.valid ? 0 : 2;
    }
    if (action === "replay") {
        const result = replayFlight(ctx.cwd, asString(values, "id"), asString(values, "to"), asString(values, "path"));
        writeOutput(json ? JSON.stringify(result, null, 2) : renderFlightReplay(result), ctx.flags.output);
        log.success(`Replay: ${result.path}`);
        return 0;
    }
    if (action === "bisect") {
        const command = explicitCommand ?? positionals.slice(1);
        if (command.length === 0) {
            throw new PilotError("Не указана команда для bisect.", {
                hint: "Используйте: oc-pilot flight bisect -- <команда...>.",
            });
        }
        const result = bisectFlight(ctx.cwd, asString(values, "id"), command, timeoutOf(values));
        writeOutput(json ? JSON.stringify(result, null, 2) : renderFlightBisect(result), ctx.flags.output);
        return result.firstBad ? 1 : 0;
    }
    if (action === "diff") {
        const result = diffFlight(ctx.cwd, asString(values, "id"), asString(values, "from"), asString(values, "to"));
        writeOutput(json ? JSON.stringify(result, null, 2) : renderFlightDiff(result), ctx.flags.output);
        return 0;
    }
    if (action === "compare") {
        const first = positionals[1] ?? asString(values, "id");
        const second = positionals[2] ?? asString(values, "with");
        if (!first || !second) {
            throw new PilotError("Для compare нужны два идентификатора полётов.", {
                hint: "Используйте: oc-pilot flight compare <id-a> <id-b>.",
            });
        }
        const result = compareFlights(ctx.cwd, first, second);
        writeOutput(json ? JSON.stringify(result, null, 2) : renderFlightCompare(result), ctx.flags.output);
        return result.a.valid && result.b.valid ? 0 : 2;
    }
    if (action === "html") {
        const result = exportFlight(ctx.cwd, asString(values, "id"));
        const html = renderFlightHtml(result);
        writeOutput(json ? JSON.stringify({ id: result.meta.id, html }, null, 2) : html, ctx.flags.output);
        log.success(`HTML-отчёт ${result.meta.id} записан.`);
        return 0;
    }
    if (action === "export") {
        const result = exportFlight(ctx.cwd, asString(values, "id"));
        writeOutput(json ? JSON.stringify(result, null, 2) : renderFlightExport(result), ctx.flags.output);
        log.success(`Экспорт ${result.meta.id}: ${result.digest}.`);
        return 0;
    }
    if (action === "end") {
        const result = endFlight(ctx.cwd);
        writeOutput(json
            ? JSON.stringify({ meta: result.meta, summary: result.summary }, null, 2)
            : renderFlightEnd(result.summary), ctx.flags.output);
        log.success("Полёт завершён.");
        return 0;
    }
    writeOutput(HELP);
    log.warn(`Неизвестное действие flight: ${action}.`);
    return 1;
}
//# sourceMappingURL=flight.js.map