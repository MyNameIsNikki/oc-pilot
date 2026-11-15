import { PilotError } from "../core/errors.js";
import { auditFlights, bisectFlight, compareFlights, createCheckpoint, diffFlight, endFlight, execInFlight, exportFlight, flightStats, flightStatus, generateFlightKey, listFlights, pruneFlights, renderFlightAudit, renderFlightBisect, renderFlightBundleVerify, renderFlightCheckpoint, renderFlightCompare, renderFlightCompareHtml, renderFlightDiff, renderFlightEnd, renderFlightExec, renderFlightExport, renderFlightHtml, renderFlightList, renderFlightPrune, renderFlightReplay, renderFlightRestore, renderFlightShow, renderFlightStart, renderFlightStats, renderFlightStatsHtml, renderFlightStatus, renderFlightVerify, replayFlight, restoreFlight, showFlight, startFlight, verifyFlightBundle, } from "../core/flight.js";
import { writeOutput, writeSecretOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";
const OPTIONS = withCommon({
    name: { type: "string" },
    label: { type: "string" },
    timeout: { type: "string" },
    id: { type: "string" },
    with: { type: "string" },
    keep: { type: "string" },
    limit: { type: "string" },
    "older-than": { type: "string" },
    "dry-run": { type: "boolean" },
    force: { type: "boolean" },
    all: { type: "boolean" },
    key: { type: "string" },
    html: { type: "boolean" },
    to: { type: "string" },
    from: { type: "string" },
    path: { type: "string" },
});
const HELP = `Использование:
  oc-pilot flight keygen [--output <файл>]
  oc-pilot flight start [--name <имя>]
  oc-pilot flight exec [--timeout <мс>] -- <команда...>
  oc-pilot flight checkpoint [--label <метка>]
  oc-pilot flight status
  oc-pilot flight stats [--html]
  oc-pilot flight prune [--keep <n>] [--older-than <дней>] [--dry-run]
  oc-pilot flight list [--limit <n>]
  oc-pilot flight show [<id>]
  oc-pilot flight restore <метка|commit> [--id <id>] [--force] [--dry-run]
  oc-pilot flight replay [--to <метка|commit>] [--id <id>] [--path <путь>]
  oc-pilot flight bisect [--id <id>] [--timeout <мс>] -- <команда...>
  oc-pilot flight diff [--from <метка|commit>] [--to <метка|commit>] [--id <id>]
  oc-pilot flight compare <id-a> <id-b> [--html]
  oc-pilot flight html [--id <id>] [--output <файл>]
  oc-pilot flight export [--id <id>] [--output <файл>] [--key <файл>]
  oc-pilot flight verify-bundle <файл> [--key <файл>]
  oc-pilot flight end
  oc-pilot flight verify [<id>] [--all]

Чёрный ящик агентской сессии: журнал событий с хеш-цепочкой и
чекпоинтами рабочего дерева. Журнал лежит в .git/oc-pilot/flights/<id>.

Опции:
      --name <имя>          имя полёта для start
      --label <метка>       метка чекпоинта
      --timeout <мс>        таймаут команды для exec/bisect (по умолчанию 600000)
      --id <id>             идентификатор полёта
      --with <id>           второй полёт для compare
      --keep <n>            сколько последних полётов оставить при prune (по умолчанию 20)
      --limit <n>           сколько последних полётов показать в list
      --older-than <дней>   удалять только полёты старше указанного возраста
      --dry-run             показать план без изменений (prune/restore)
      --key <файл>          HMAC-ключ для подписи export и проверки verify-bundle
      --html                HTML-отчёт для compare
      --force               восстановить поверх изменённого рабочего дерева
      --all                 проверить цепочки всех полётов (verify)
      --to <ref>            чекпоинт для replay/diff: метка или commit
      --from <ref>          начальный чекпоинт для diff
      --path <путь>         каталог для replay-worktree
${COMMON_HELP}
Коды возврата:
  0  успех
  1  ошибка oc-pilot или провал bisect
  2  полёт не запущен, полёт не найден или журнал повреждён
  exec возвращает код команды (124 при таймауте)

Примеры:
  oc-pilot flight keygen --output flight.key
  oc-pilot flight start --name "fix auth"
  oc-pilot flight stats --html --output stats.html
  oc-pilot flight prune --keep 20 --dry-run
  oc-pilot flight exec -- npm test
  oc-pilot flight checkpoint --label "tests green"
  oc-pilot flight restore "tests green"
  oc-pilot flight replay --to "tests green"
  oc-pilot flight bisect -- node --test
  oc-pilot flight diff --from base --to "tests green"
  oc-pilot flight compare 20261114T120000-ab12cd 20261114T130000-cd34ef
  oc-pilot flight compare 20261114T120000-ab12cd 20261114T130000-cd34ef --html --output compare.html
  oc-pilot flight html --output flight.html
  oc-pilot flight export --key flight.key --output flight.json
  oc-pilot flight verify-bundle flight.json --key flight.key
  oc-pilot flight verify 20261114T120000-ab12cd`;
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
function optionalNonNegativeInteger(values, key, label) {
    const raw = asString(values, key);
    if (raw === undefined)
        return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
        throw new PilotError(`Некорректный ${label}: ${raw}`, {
            hint: "Укажите неотрицательное целое число.",
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
    if (action === "keygen") {
        const key = generateFlightKey();
        const payload = json ? JSON.stringify({ key }, null, 2) : key;
        const written = writeSecretOutput(payload, ctx.flags.output, ctx.cwd);
        log.success(written ? `Ключ записан в ${written}.` : "Ключ сгенерирован.");
        return 0;
    }
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
        writeOutput(asBoolean(values, "html")
            ? renderFlightStatsHtml(stats)
            : json
                ? JSON.stringify(stats, null, 2)
                : renderFlightStats(stats), ctx.flags.output);
        return 0;
    }
    if (action === "list") {
        const limit = optionalNonNegativeInteger(values, "limit", "--limit");
        const all = listFlights(ctx.cwd);
        const flights = limit === undefined ? all : all.slice(0, limit);
        writeOutput(json ? JSON.stringify({ flights }, null, 2) : renderFlightList(flights), ctx.flags.output);
        return 0;
    }
    if (action === "show") {
        const show = showFlight(ctx.cwd, asString(values, "id") ?? positionals[1]);
        writeOutput(json ? JSON.stringify(show, null, 2) : renderFlightShow(show), ctx.flags.output);
        return show.verification.valid ? 0 : 2;
    }
    if (action === "verify") {
        if (asBoolean(values, "all")) {
            const audit = auditFlights(ctx.cwd);
            writeOutput(json ? JSON.stringify(audit, null, 2) : renderFlightAudit(audit), ctx.flags.output);
            return audit.tampered === 0 ? 0 : 2;
        }
        const show = showFlight(ctx.cwd, asString(values, "id") ?? positionals[1]);
        writeOutput(json
            ? JSON.stringify({ id: show.meta.id, ...show.verification }, null, 2)
            : renderFlightVerify(show.verification), ctx.flags.output);
        return show.verification.valid ? 0 : 2;
    }
    if (action === "restore") {
        const ref = positionals[1];
        if (!ref) {
            throw new PilotError("Не указан чекпоинт для restore.", {
                hint: "Используйте: oc-pilot flight restore <метка|commit> [--force].",
            });
        }
        const result = restoreFlight(ctx.cwd, ref, asString(values, "id"), asBoolean(values, "force"), asBoolean(values, "dry-run"));
        writeOutput(json ? JSON.stringify(result, null, 2) : renderFlightRestore(result), ctx.flags.output);
        log.success(`Восстановлено: ${result.label}.`);
        return 0;
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
        writeOutput(asBoolean(values, "html")
            ? renderFlightCompareHtml(result)
            : json
                ? JSON.stringify(result, null, 2)
                : renderFlightCompare(result), ctx.flags.output);
        return result.a.valid && result.b.valid ? 0 : 2;
    }
    if (action === "html") {
        const result = exportFlight(ctx.cwd, asString(values, "id"));
        const html = renderFlightHtml(result);
        writeOutput(json ? JSON.stringify({ id: result.meta.id, html }, null, 2) : html, ctx.flags.output);
        log.success(`HTML-отчёт ${result.meta.id} записан.`);
        return 0;
    }
    if (action === "verify-bundle") {
        const file = positionals[1];
        if (!file) {
            throw new PilotError("Не указан файл flight bundle.", {
                hint: "Используйте: oc-pilot flight verify-bundle <файл> [--key <файл>].",
            });
        }
        const result = verifyFlightBundle(file, asString(values, "key"));
        writeOutput(json ? JSON.stringify(result, null, 2) : renderFlightBundleVerify(result), ctx.flags.output);
        return result.valid ? 0 : 2;
    }
    if (action === "export") {
        const result = exportFlight(ctx.cwd, asString(values, "id"), asString(values, "key"));
        writeOutput(json ? JSON.stringify(result, null, 2) : renderFlightExport(result), ctx.flags.output);
        log.success(`Экспорт ${result.meta.id}: ${result.digest}.`);
        return 0;
    }
    if (action === "prune") {
        const result = pruneFlights(ctx.cwd, {
            keep: optionalNonNegativeInteger(values, "keep", "--keep"),
            olderThanDays: optionalNonNegativeInteger(values, "older-than", "--older-than"),
            dryRun: asBoolean(values, "dry-run"),
        });
        writeOutput(json ? JSON.stringify(result, null, 2) : renderFlightPrune(result), ctx.flags.output);
        log.success(result.dryRun
            ? `Будет удалено ${result.removed.length} полётов.`
            : `Удалено ${result.removed.length} полётов.`);
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