import { PilotError } from "../core/errors.js";
import {
  createCheckpoint,
  endFlight,
  execInFlight,
  flightStatus,
  listFlights,
  renderFlightCheckpoint,
  renderFlightEnd,
  renderFlightExec,
  renderFlightList,
  renderFlightShow,
  renderFlightStart,
  renderFlightStatus,
  renderFlightVerify,
  showFlight,
  startFlight,
} from "../core/flight.js";
import { writeOutput } from "../core/io.js";
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
});

const HELP = `Использование:
  oc-pilot flight start [--name <имя>]
  oc-pilot flight exec [--timeout <мс>] -- <команда...>
  oc-pilot flight checkpoint [--label <метка>]
  oc-pilot flight status
  oc-pilot flight list
  oc-pilot flight show <id>
  oc-pilot flight end
  oc-pilot flight verify <id>

Чёрный ящик агентской сессии: журнал событий с хеш-цепочкой и
чекпоинтами рабочего дерева. Журнал лежит в .git/oc-pilot/flights/<id>.

Опции:
      --name <имя>          имя полёта для start
      --label <метка>       метка чекпоинта
      --timeout <мс>        таймаут команды для exec (по умолчанию 600000)
      --id <id>             идентификатор для show/verify
${COMMON_HELP}
Коды возврата:
  0  успех
  1  ошибка или команда exec завершилась с ненулевым кодом
  2  полёт не запущен или журнал повреждён

Примеры:
  oc-pilot flight start --name "fix auth"
  oc-pilot flight exec -- npm test
  oc-pilot flight checkpoint --label "tests green"
  oc-pilot flight verify 20261114T120000-ab12cd`;

function requireId(values: ArgsValues, positionals: string[]): string {
  const id = asString(values, "id") ?? positionals[1];
  if (!id) {
    throw new PilotError("Не указан идентификатор полёта.", {
      hint: "Посмотрите список: oc-pilot flight list.",
    });
  }
  return id;
}

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

export function runFlight(argv: string[]): number {
  let args = [...argv];
  let explicitCommand: string[] | undefined;
  if (args[0] === "exec") {
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
    writeOutput(
      json ? JSON.stringify({ active: true, session }, null, 2) : renderFlightStart(session),
      ctx.flags.output,
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
    writeOutput(
      json ? JSON.stringify(result, null, 2) : renderFlightExec(result),
      ctx.flags.output,
    );
    if (result.timedOut) return 124;
    return result.exitCode ?? 1;
  }

  if (action === "checkpoint") {
    const label = asString(values, "label") ?? new Date().toISOString();
    const checkpoint = createCheckpoint(ctx.cwd, label);
    writeOutput(
      json ? JSON.stringify(checkpoint, null, 2) : renderFlightCheckpoint(checkpoint),
      ctx.flags.output,
    );
    log.success(`Чекпоинт ${checkpoint.label} записан.`);
    return 0;
  }

  if (action === "status") {
    const status = flightStatus(ctx.cwd);
    writeOutput(
      json ? JSON.stringify(status, null, 2) : renderFlightStatus(status),
      ctx.flags.output,
    );
    return status.active ? 0 : 2;
  }

  if (action === "list") {
    const flights = listFlights(ctx.cwd);
    writeOutput(
      json ? JSON.stringify({ flights }, null, 2) : renderFlightList(flights),
      ctx.flags.output,
    );
    return 0;
  }

  if (action === "show") {
    const show = showFlight(ctx.cwd, requireId(values, positionals));
    writeOutput(
      json ? JSON.stringify(show, null, 2) : renderFlightShow(show),
      ctx.flags.output,
    );
    return show.verification.valid ? 0 : 2;
  }

  if (action === "verify") {
    const show = showFlight(ctx.cwd, requireId(values, positionals));
    writeOutput(
      json
        ? JSON.stringify({ id: show.meta.id, ...show.verification }, null, 2)
        : renderFlightVerify(show.verification),
      ctx.flags.output,
    );
    return show.verification.valid ? 0 : 2;
  }

  if (action === "end") {
    const result = endFlight(ctx.cwd);
    writeOutput(
      json
        ? JSON.stringify({ meta: result.meta, summary: result.summary }, null, 2)
        : renderFlightEnd(result.summary),
      ctx.flags.output,
    );
    log.success("Полёт завершён.");
    return 0;
  }

  writeOutput(HELP);
  log.warn(`Неизвестное действие flight: ${action}.`);
  return 1;
}
