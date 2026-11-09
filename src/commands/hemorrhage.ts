import { describeDiffSource, loadDiff } from "../core/diff-source.js";
import { PilotError } from "../core/errors.js";
import {
  runHemorrhage,
  type HemorrhageDirection,
  type HemorrhageMetric,
} from "../core/hemorrhage.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean, asString, parsePositiveInt, parseSeconds } from "../core/parse.js";

const OPTIONS: OptionSpec = withCommon({
  command: { type: "string" },
  metric: { type: "string" },
  direction: { type: "string" },
  runs: { type: "string" },
  warmup: { type: "string" },
  threshold: { type: "string" },
  "run-timeout": { type: "string" },
  diff: { type: "string" },
  stdin: { type: "boolean" },
  staged: { type: "boolean" },
  unstaged: { type: "boolean" },
  base: { type: "string" },
  "include-untracked": { type: "boolean" },
});

const HELP = `Использование:
  oc-pilot hemorrhage --command "node bench.mjs" [опции]

Запускает один и тот же бенчмарк на HEAD и на diff в двух shadow
worktree, чередуя порядок, и сравнивает медианы, p95 и MAD.
--metric time меряет стенное время, --metric stdout берёт число из
вывода. Регрессия объявляется только при превышении порога, шума и
значимости Mann-Whitney (p < 0.05).

Опции:
      --command <cmd>            бенчмарк, печатающий число или работающий измеримо
      --metric <time|stdout>     что сравнивать (по умолчанию time)
      --direction <lower|higher> что лучше (по умолчанию lower)
      --runs <10>                замеров на каждую сторону (3–50)
      --warmup <2>               прогревочных прогонов (0–10)
      --threshold <5>            порог регрессии в процентах (0–100)
      --run-timeout <120s>       таймаут одного прогона
      --diff <file|->            готовый unified diff
      --stdin                    читать diff из stdin
      --staged                   только staged-изменения
      --unstaged                 только unstaged-изменения
      --base <ref>               diff против ветки
      --include-untracked        добавить неотслеживаемые файлы
${COMMON_HELP}

Коды выхода:
  0  регрессии нет
  1  [PERFORMANCE REGRESSION]
  2  ошибка бенчмарка или git

Примеры:
  oc-pilot hemorrhage --command "node bench.mjs" --runs 10 --threshold 5
  oc-pilot hemorrhage --command "node bench.mjs" --metric stdout --direction higher`;

function parseMetric(raw: string | undefined): HemorrhageMetric {
  if (raw === undefined || raw.trim() === "") return "time";
  if (raw === "time" || raw === "stdout") return raw;
  throw new PilotError(`Неизвестная метрика: ${raw}`, {
    hint: "Используйте time или stdout.",
    exitCode: 2,
  });
}

function parseDirection(raw: string | undefined): HemorrhageDirection {
  if (raw === undefined || raw.trim() === "") return "lower";
  if (raw === "lower" || raw === "higher") return raw;
  throw new PilotError(`Неизвестное направление: ${raw}`, {
    hint: "Используйте lower или higher.",
    exitCode: 2,
  });
}

function parseThreshold(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new PilotError(`Некорректный порог: ${raw}`, {
      hint: "Используйте число от 0 до 100.",
      exitCode: 2,
    });
  }
  return value;
}

export async function runHemorrhageCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (positionals.length > 0) {
    throw new PilotError("hemorrhage не принимает позиционных аргументов", {
      hint: "Передайте бенчмарк через --command.",
      exitCode: 2,
    });
  }

  const ctx = resolveContext(values);
  const command = asString(values, "command");
  if (!command) {
    throw new PilotError("Нужна команда бенчмарка", {
      hint: 'Например: --command "node bench.mjs".',
      exitCode: 2,
    });
  }

  const data = await loadDiff(values, ctx, [], { optionalGit: true });
  if (!data.diff.trim()) {
    log.info("Изменений нет — сравнивать производительность нечего.");
    return 0;
  }

  const runsRaw = asString(values, "runs");
  const warmupRaw = asString(values, "warmup");
  const timeoutRaw = asString(values, "run-timeout");
  const report = await runHemorrhage(ctx.cwd, data.diff, {
    command,
    metric: parseMetric(asString(values, "metric")),
    direction: parseDirection(asString(values, "direction")),
    runs: runsRaw ? parsePositiveInt(runsRaw, "runs", 50) : undefined,
    warmup: warmupRaw ? parsePositiveInt(warmupRaw, "warmup", 10) : undefined,
    thresholdPct: parseThreshold(asString(values, "threshold")),
    timeoutMs: timeoutRaw ? parseSeconds(timeoutRaw, "run-timeout") * 1000 : undefined,
  });

  const wrote = ctx.flags.json
    ? writeOutput(
        JSON.stringify({ source: describeDiffSource(data.source), ...report }, null, 2),
        ctx.flags.output,
      )
    : writeOutput(report.content, ctx.flags.output);
  if (wrote) log.success(`Результат сохранён: ${wrote}`);

  if (report.status === "regression") {
    log.error(report.summary);
    return 1;
  }
  if (report.status === "improvement") log.success(report.summary);
  else log.info(report.summary);
  return 0;
}
