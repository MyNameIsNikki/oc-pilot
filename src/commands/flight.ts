import { PilotError } from "../core/errors.js";
import {
  auditFlights,
  addFlightNote,
  bisectFlight,
  compareFlights,
  compareFlightShows,
  createCheckpoint,
  diffFlight,
  deleteFlight,
  endFlight,
  execInFlight,
  exportFlight,
  flightShowFromBundle,
  flightStats,
  flightStatus,
  filterFlightEvents,
  generateFlightKey,
  grepFlightBundle,
  grepFlights,
  listFlights,
  loadFlightBundle,
  pruneFlights,
  renderFlightAudit,
  renderFlightBisect,
  renderFlightBundleVerify,
  renderFlightCheckpoint,
  renderFlightCompare,
  renderFlightCompareHtml,
  renderFlightDelete,
  renderFlightDiff,
  renderFlightEnd,
  renderFlightExec,
  renderFlightExport,
  renderFlightHtml,
  renderFlightGrep,
  renderFlightList,
  renderFlightPrune,
  renderFlightReplay,
  renderFlightRestore,
  renderFlightShow,
  renderFlightStart,
  renderFlightStats,
  renderFlightStatsHtml,
  renderFlightSummary,
  renderFlightStatus,
  renderFlightVerify,
  replayFlight,
  restoreFlight,
  showFlight,
  signFlightBundle,
  startFlight,
  verifyFlightBundle,
  verifyFlightEvents,
} from "../core/flight.js";
import { writeOutput, writeSecretOutput } from "../core/io.js";
import { log } from "../core/log.js";
import {
  COMMON_HELP,
  parseCommandArgs,
  resolveContext,
  withCommon,
  type OptionSpec,
} from "../core/options.js";
import { asBoolean, asString, type ArgsValues } from "../core/parse.js";

const OPTIONS: OptionSpec = withCommon({
  name: { type: "string" },
  label: { type: "string" },
  timeout: { type: "string" },
  id: { type: "string" },
  with: { type: "string" },
  keep: { type: "string" },
  limit: { type: "string" },
  kind: { type: "string" },
  last: { type: "string" },
  "older-than": { type: "string" },
  "dry-run": { type: "boolean" },
  force: { type: "boolean" },
  all: { type: "boolean" },
  key: { type: "string" },
  bundle: { type: "string" },
  bundles: { type: "boolean" },
  html: { type: "boolean" },
  to: { type: "string" },
  from: { type: "string" },
  path: { type: "string" },
});

const HELP = `Использование:
  oc-pilot flight keygen [--output <файл>]
  oc-pilot flight start [--name <имя>]
  oc-pilot flight exec [--timeout <мс>] -- <команда...>
  oc-pilot flight note <текст>
  oc-pilot flight checkpoint [--label <метка>]
  oc-pilot flight status
  oc-pilot flight stats [--html]
  oc-pilot flight prune [--keep <n>] [--older-than <дней>] [--dry-run]
  oc-pilot flight delete <id> [--dry-run]
  oc-pilot flight grep <текст> [--id <id>] [--bundle <файл>] [--limit <n>] [--kind <тип>]
  oc-pilot flight list [--limit <n>]
  oc-pilot flight show [<id>] [--bundle <файл>] [--kind <тип>] [--last <n>]
  oc-pilot flight restore <метка|commit> [--id <id>] [--force] [--dry-run]
  oc-pilot flight replay [--to <метка|commit>] [--id <id>] [--path <путь>]
  oc-pilot flight bisect [--id <id>] [--timeout <мс>] -- <команда...>
  oc-pilot flight diff [--from <метка|commit>] [--to <метка|commit>] [--id <id>]
  oc-pilot flight compare <id-a> <id-b> [--bundles] [--html]
  oc-pilot flight summary [--id <id>] [--bundle <файл>] [--output <файл>]
  oc-pilot flight html [--id <id>] [--bundle <файл>] [--output <файл>]
  oc-pilot flight export [--id <id>] [--bundle <файл>] [--output <файл>] [--key <файл>]
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
      --limit <n>           сколько последних полётов показать в list или совпадений в grep
      --kind <тип>          фильтр событий в show и grep: note, command.start, command.end, file.checkpoint и др.
      --last <n>            показать только последние n событий в show
      --older-than <дней>   удалять только полёты старше указанного возраста
      --dry-run             показать план без изменений (prune/restore/delete)
      --bundle <файл>       читать из экспортированного bundle (show/html/summary/grep) или переподписать его
      --key <файл>          HMAC-ключ для подписи export и проверки verify-bundle
      --html                HTML-отчёт для compare
      --bundles             сравнивать два экспортированных bundle вместо сессий
      --force               восстановить поверх изменённого рабочего дерева
      --all                 проверить цепочки всех полётов (verify)
      --to <ref>            чекпоинт для replay/diff: метка или commit
      --from <ref>          начальный чекпоинт для diff
      --path <путь>         каталог для replay-worktree
${COMMON_HELP}
Коды возврата:
  0  успех
  1  ошибка oc-pilot или провал bisect
  2  полёт не запущен, полёт или чекпоинт не найден, журнал повреждён
  exec возвращает код команды (124 при таймауте)

Примеры:
  oc-pilot flight keygen --output flight.key
  oc-pilot flight start --name "fix auth"
  oc-pilot flight note "почему выбран этот фикс"
  oc-pilot flight stats --html --output stats.html
  oc-pilot flight prune --keep 20 --dry-run
  oc-pilot flight delete <id> --dry-run
  oc-pilot flight grep "почему"
  oc-pilot flight exec -- npm test
  oc-pilot flight checkpoint --label "tests green"
  oc-pilot flight restore "tests green"
  oc-pilot flight replay --to "tests green"
  oc-pilot flight bisect -- node --test
  oc-pilot flight diff --from base --to "tests green"
  oc-pilot flight compare 20261114T120000-ab12cd 20261114T130000-cd34ef
  oc-pilot flight compare 20261114T120000-ab12cd 20261114T130000-cd34ef --html --output compare.html
  oc-pilot flight compare --bundles a.json b.json
  oc-pilot flight html --output flight.html
  oc-pilot flight export --key flight.key --output flight.json
  oc-pilot flight export --bundle flight.json --key new.key --output resigned.json
  oc-pilot flight verify-bundle flight.json --key flight.key
  oc-pilot flight verify 20261114T120000-ab12cd`;

function timeoutOf(values: ArgsValues): number {
  const raw = asString(values, "timeout");
  if (raw === undefined) return 600_000;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new PilotError(`Некорректный таймаут: ${raw}`, {
      hint: "Укажите положительное целое число миллисекунд.",
    });
  }
  return value;
}

function optionalNonNegativeInteger(
  values: ArgsValues,
  key: string,
  label: string,
): number | undefined {
  const raw = asString(values, key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new PilotError(`Некорректный ${label}: ${raw}`, {
      hint: "Укажите неотрицательное целое число.",
    });
  }
  return value;
}

export function runFlight(argv: string[]): number {
  let args = [...argv];
  let explicitCommand: string[] | undefined;
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
  const flightOutput = (text: string) => writeOutput(text, ctx.flags.output, ctx.cwd);

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
    flightOutput(
      json ? JSON.stringify({ active: true, session }, null, 2) : renderFlightStart(session),
    );
    log.success(`Полёт ${session.meta.id} начат.`);
    return 0;
  }

  if (action === "exec") {
    const command = explicitCommand ?? positionals.slice(1);
    const result = execInFlight(ctx.cwd, command, {
      timeoutMs: timeoutOf(values),
      quiet: json,
    });
    flightOutput(
      json ? JSON.stringify(result, null, 2) : renderFlightExec(result),
    );
    if (result.timedOut) return 124;
    return result.exitCode ?? 1;
  }

  if (action === "note") {
    const text = positionals.slice(1).join(" ").trim();
    if (!text) {
      throw new PilotError("Не указан текст заметки.", {
        hint: "Используйте: oc-pilot flight note \"что произошло и почему\".",
      });
    }
    const result = addFlightNote(ctx.cwd, text);
    flightOutput(
      json ? JSON.stringify(result, null, 2) : `[FLIGHT NOTE] #${result.seq}: ${result.note}`,
    );
    log.success("Заметка записана.");
    return 0;
  }

  if (action === "checkpoint") {
    const label = asString(values, "label") ?? new Date().toISOString();
    const checkpoint = createCheckpoint(ctx.cwd, label);
    flightOutput(
      json ? JSON.stringify(checkpoint, null, 2) : renderFlightCheckpoint(checkpoint),
    );
    log.success(`Чекпоинт ${checkpoint.label} записан.`);
    return 0;
  }

  if (action === "status") {
    const status = flightStatus(ctx.cwd);
    flightOutput(
      json ? JSON.stringify(status, null, 2) : renderFlightStatus(status),
    );
    return status.active ? 0 : 2;
  }

  if (action === "stats") {
    const stats = flightStats(ctx.cwd);
    flightOutput(
      asBoolean(values, "html")
        ? renderFlightStatsHtml(stats)
        : json
          ? JSON.stringify(stats, null, 2)
          : renderFlightStats(stats),
    );
    return 0;
  }

  if (action === "grep") {
    const text = positionals.slice(1).join(" ").trim();
    if (!text) {
      throw new PilotError("Не указан текст для поиска.", {
        hint: 'Используйте: oc-pilot flight grep "что искать".',
      });
    }
    const limit = optionalNonNegativeInteger(values, "limit", "--limit");
    const kind = asString(values, "kind");
    const bundlePath = asString(values, "bundle");
    const result = bundlePath
      ? grepFlightBundle(bundlePath, text, limit, kind)
      : grepFlights(ctx.cwd, text, asString(values, "id"), limit, kind);
    flightOutput(json ? JSON.stringify(result, null, 2) : renderFlightGrep(result));
    log.success(`Найдено совпадений: ${result.matches.length}.`);
    if (!bundlePath) return 0;
    const bundleCheck = verifyFlightBundle(bundlePath);
    return bundleCheck.digestOk && bundleCheck.chainOk ? 0 : 2;
  }

  if (action === "list") {
    const limit = optionalNonNegativeInteger(values, "limit", "--limit");
    const all = listFlights(ctx.cwd);
    const flights = limit === undefined ? all : all.slice(0, limit);
    flightOutput(
      json ? JSON.stringify({ flights }, null, 2) : renderFlightList(flights),
    );
    return 0;
  }

  if (action === "show") {
    const bundlePath = asString(values, "bundle");
    const show = bundlePath
      ? flightShowFromBundle(loadFlightBundle(bundlePath))
      : showFlight(ctx.cwd, asString(values, "id") ?? positionals[1]);
    const kind = asString(values, "kind");
    const last = optionalNonNegativeInteger(values, "last", "--last");
    const events =
      kind === undefined && last === undefined
        ? show.events
        : filterFlightEvents(show.events, kind, last);
    const filtered = { ...show, events };
    flightOutput(
      json
        ? JSON.stringify({ ...filtered, totalEvents: show.events.length }, null, 2)
        : renderFlightShow(filtered),
    );
    if (bundlePath) {
      const check = verifyFlightBundle(bundlePath);
      return check.digestOk && check.chainOk ? 0 : 2;
    }
    return show.verification.valid ? 0 : 2;
  }

  if (action === "verify") {
    if (asBoolean(values, "all")) {
      const audit = auditFlights(ctx.cwd);
      flightOutput(
        json ? JSON.stringify(audit, null, 2) : renderFlightAudit(audit),
      );
      return audit.tampered === 0 ? 0 : 2;
    }
    const show = showFlight(ctx.cwd, asString(values, "id") ?? positionals[1]);
    flightOutput(
      json
        ? JSON.stringify({ id: show.meta.id, ...show.verification }, null, 2)
        : renderFlightVerify(show.verification),
    );
    return show.verification.valid ? 0 : 2;
  }

  if (action === "restore") {
    const ref = positionals[1];
    if (!ref) {
      throw new PilotError("Не указан чекпоинт для restore.", {
        hint: "Используйте: oc-pilot flight restore <метка|commit> [--force].",
      });
    }
    const result = restoreFlight(
      ctx.cwd,
      ref,
      asString(values, "id"),
      asBoolean(values, "force"),
      asBoolean(values, "dry-run"),
    );
    flightOutput(
      json ? JSON.stringify(result, null, 2) : renderFlightRestore(result),
    );
    log.success(`Восстановлено: ${result.label}.`);
    return 0;
  }

  if (action === "replay") {
    const result = replayFlight(
      ctx.cwd,
      asString(values, "id"),
      asString(values, "to"),
      asString(values, "path"),
    );
    flightOutput(
      json ? JSON.stringify(result, null, 2) : renderFlightReplay(result),
    );
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
    flightOutput(
      json ? JSON.stringify(result, null, 2) : renderFlightBisect(result),
    );
    return result.firstBad ? 1 : 0;
  }

  if (action === "diff") {
    const result = diffFlight(
      ctx.cwd,
      asString(values, "id"),
      asString(values, "from"),
      asString(values, "to"),
    );
    flightOutput(
      json ? JSON.stringify(result, null, 2) : renderFlightDiff(result),
    );
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
    const result = asBoolean(values, "bundles")
      ? compareFlightShows(
          flightShowFromBundle(loadFlightBundle(first)),
          flightShowFromBundle(loadFlightBundle(second)),
        )
      : compareFlights(ctx.cwd, first, second);
    flightOutput(
      asBoolean(values, "html")
        ? renderFlightCompareHtml(result)
        : json
          ? JSON.stringify(result, null, 2)
          : renderFlightCompare(result),
    );
    const bundlesOk = asBoolean(values, "bundles")
      ? [first, second].every((file) => {
          const check = verifyFlightBundle(file);
          return check.digestOk && check.chainOk;
        })
      : true;
    return result.a.valid && result.b.valid && bundlesOk ? 0 : 2;
  }

  if (action === "summary") {
    const bundlePath = asString(values, "bundle");
    const show = bundlePath
      ? flightShowFromBundle(loadFlightBundle(bundlePath))
      : showFlight(ctx.cwd, asString(values, "id"));
    const markdown = renderFlightSummary(show);
    flightOutput(
      json ? JSON.stringify({ id: show.meta.id, markdown }, null, 2) : markdown,
    );
    log.success(`Сводка ${show.meta.id} записана.`);
    if (bundlePath) {
      const check = verifyFlightBundle(bundlePath);
      return check.digestOk && check.chainOk ? 0 : 2;
    }
    return show.verification.valid ? 0 : 2;
  }

  if (action === "html") {
    const bundlePath = asString(values, "bundle");
    const result = bundlePath
      ? loadFlightBundle(bundlePath)
      : exportFlight(ctx.cwd, asString(values, "id"));
    const html = renderFlightHtml(result);
    flightOutput(
      json ? JSON.stringify({ id: result.meta.id, html }, null, 2) : html,
    );
    log.success(`HTML-отчёт ${result.meta.id} записан.`);
    if (bundlePath) {
      const check = verifyFlightBundle(bundlePath);
      return check.digestOk && check.chainOk ? 0 : 2;
    }
    return verifyFlightEvents(result.events).valid ? 0 : 2;
  }

  if (action === "verify-bundle") {
    const file = positionals[1];
    if (!file) {
      throw new PilotError("Не указан файл flight bundle.", {
        hint: "Используйте: oc-pilot flight verify-bundle <файл> [--key <файл>].",
      });
    }
    const result = verifyFlightBundle(file, asString(values, "key"));
    flightOutput(
      json ? JSON.stringify(result, null, 2) : renderFlightBundleVerify(result),
    );
    return result.valid ? 0 : 2;
  }

  if (action === "export") {
    const bundlePath = asString(values, "bundle");
    const keyPath = asString(values, "key");
    if (bundlePath && !keyPath) {
      throw new PilotError("Для повторной подписи bundle нужен --key.", {
        hint: "Используйте: oc-pilot flight export --bundle <файл> --key <файл>.",
      });
    }
    const result = bundlePath
      ? signFlightBundle(loadFlightBundle(bundlePath), keyPath as string)
      : exportFlight(ctx.cwd, asString(values, "id"), keyPath);
    flightOutput(
      json ? JSON.stringify(result, null, 2) : renderFlightExport(result),
    );
    log.success(`Экспорт ${result.meta.id}: ${result.digest}.`);
    return 0;
  }

  if (action === "delete") {
    const id = positionals[1];
    if (!id) {
      throw new PilotError("Не указан идентификатор полёта.", {
        hint: "Используйте: oc-pilot flight delete <id>.",
      });
    }
    const result = deleteFlight(ctx.cwd, id, asBoolean(values, "dry-run"));
    flightOutput(
      json ? JSON.stringify(result, null, 2) : renderFlightDelete(result),
    );
    log.success(
      result.dryRun
        ? `Будет удалён полёт ${result.id}.`
        : `Полёт ${result.id} удалён.`,
    );
    return 0;
  }

  if (action === "prune") {
    const result = pruneFlights(ctx.cwd, {
      keep: optionalNonNegativeInteger(values, "keep", "--keep"),
      olderThanDays: optionalNonNegativeInteger(values, "older-than", "--older-than"),
      dryRun: asBoolean(values, "dry-run"),
    });
    flightOutput(
      json ? JSON.stringify(result, null, 2) : renderFlightPrune(result),
    );
    log.success(
      result.dryRun
        ? `Будет удалено ${result.removed.length} полётов.`
        : `Удалено ${result.removed.length} полётов.`,
    );
    return 0;
  }

  if (action === "end") {
    const result = endFlight(ctx.cwd);
    flightOutput(
      json
        ? JSON.stringify({ meta: result.meta, summary: result.summary }, null, 2)
        : renderFlightEnd(result.summary),
    );
    log.success("Полёт завершён.");
    return 0;
  }

  flightOutput(HELP);
  log.warn(`Неизвестное действие flight: ${action}.`);
  return 1;
}
