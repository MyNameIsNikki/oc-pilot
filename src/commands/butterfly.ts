import { PilotError } from "../core/errors.js";
import { renderButterfly, runButterfly } from "../core/butterfly.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";
import { detectTestCommand } from "../core/project.js";

const OPTIONS: OptionSpec = withCommon({
  command: { type: "string" },
  seed: { type: "string" },
  "fail-rate": { type: "string" },
  "latency-rate": { type: "string" },
  "latency-ms": { type: "string" },
  "broken-json-rate": { type: "string" },
  "fs-fail-rate": { type: "string" },
  timeout: { type: "string" },
  scope: { type: "string" },
});

const HELP = `Использование:
  oc-pilot butterfly [опции]

Запускает тестовую команду под локальным chaos engineering:
fetch иногда получает HTTP 500, задержку или битый JSON, а fs — EIO.
Инъекции детерминированы seed и применяются только к коду в --scope,
поэтому тест-раннер и node_modules не ломаются.
Если тесты падают, значит код не обработал сбой: нужны try/catch,
таймауты и fallback. Это не ОС-песочница и не сетевой прокси;
DB-драйверы патчатся best-effort.

Опции:
      --command <cmd>          команда тестов (иначе testCommand или автоопределение)
      --seed <n>               seed инъекций (по умолчанию 42)
      --fail-rate <0.1>        доля HTTP 500 (0..1 или 10%)
      --latency-rate <0.05>    доля задержек
      --latency-ms <3000>      длительность задержки
      --broken-json-rate <0.02> доля битого JSON
      --fs-fail-rate <0.05>    доля ошибок fs
      --timeout <120s>         таймаут тестов
      --scope <src/,app/>      где применять инъекции (по умолчанию src/)
${COMMON_HELP}

Примеры:
  oc-pilot butterfly
  oc-pilot butterfly --command "npm test" --seed 7
  oc-pilot butterfly --fail-rate 0.2 --latency-rate 0.1 --json
  oc-pilot butterfly --command "node --test" --scope src/,lib/`;

function parseRate(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const text = raw.trim();
  const percent = text.endsWith("%");
  const value = Number(percent ? text.slice(0, -1) : text);
  if (!Number.isFinite(value) || value < 0) {
    throw new PilotError(`Некорректная доля --${flag}: ${raw}`, {
      hint: "Используйте 0.1, 10% или 0.",
      exitCode: 2,
    });
  }
  const normalized = percent ? value / 100 : value;
  if (normalized > 1) {
    throw new PilotError(`Некорректная доля --${flag}: ${raw}`, {
      hint: "Доля не может быть больше 1 или 100%.",
      exitCode: 2,
    });
  }
  return normalized;
}

function parseNonNegativeInt(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new PilotError(`Некорректное значение --${flag}: ${raw}`, { exitCode: 2 });
  }
  return value;
}

function parseDuration(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/i.exec(raw.trim());
  if (!match?.[1]) {
    throw new PilotError(`Некорректный таймаут: ${raw}`, {
      hint: "Используйте 120s, 2m или миллисекунды.",
      exitCode: 2,
    });
  }
  const value = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  const ms = unit === "ms" ? value : unit === "m" ? value * 60_000 : value * 1_000;
  return Math.max(1_000, Math.round(ms));
}

export async function runButterflyCommand(argv: string[]): Promise<number> {
  const { values } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  const ctx = resolveContext(values);
  const command = asString(values, "command") ?? ctx.config.testCommand ?? detectTestCommand(ctx.cwd)?.command;
  if (!command) {
    throw new PilotError("Не найдена команда тестов", {
      hint: "Укажите --command или поле testCommand в .oc-pilot.json.",
      exitCode: 2,
    });
  }

  const scopeRaw = asString(values, "scope");
  const scope = scopeRaw
    ? scopeRaw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : undefined;

  const report = await runButterfly(ctx.cwd, {
    command,
    seed: parseNonNegativeInt(asString(values, "seed"), "seed"),
    failRate: parseRate(asString(values, "fail-rate"), "fail-rate"),
    latencyRate: parseRate(asString(values, "latency-rate"), "latency-rate"),
    latencyMs: parseNonNegativeInt(asString(values, "latency-ms"), "latency-ms"),
    brokenJsonRate: parseRate(asString(values, "broken-json-rate"), "broken-json-rate"),
    fsFailRate: parseRate(asString(values, "fs-fail-rate"), "fs-fail-rate"),
    timeoutMs: parseDuration(asString(values, "timeout")),
    scope,
  });

  const wrote = ctx.flags.json
    ? writeOutput(JSON.stringify(report, null, 2), ctx.flags.output)
    : writeOutput(renderButterfly(report), ctx.flags.output);
  if (wrote) log.success(`Результат сохранён: ${wrote}`);

  if (report.status === "fail" || report.status === "timeout") {
    log.error(report.summary);
    return 1;
  }
  return 0;
}
