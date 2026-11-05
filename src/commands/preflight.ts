import type { DepSeverity } from "../core/deps-health.js";
import { loadDiff } from "../core/diff-source.js";
import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean, asString, type ArgsValues } from "../core/parse.js";
import { renderPreflight, type PreflightCheckId } from "../core/preflight.js";
import { collectPreflight } from "../core/preflight-run.js";

const OPTIONS: OptionSpec = withCommon({
  diff: { type: "string" },
  stdin: { type: "boolean" },
  staged: { type: "boolean" },
  unstaged: { type: "boolean" },
  base: { type: "string" },
  "include-untracked": { type: "boolean" },
  since: { type: "string" },
  "max-delta": { type: "string" },
  "fail-on-issue": { type: "string" },
  "no-secret-scan": { type: "boolean" },
  "no-sast": { type: "boolean" },
  "no-deps": { type: "boolean" },
  "no-tests": { type: "boolean" },
  "no-slop": { type: "boolean" },
});

const HELP = `Использование:
  oc-pilot preflight [пути] [опции]

Офлайн-проверка изменения перед коммитом: секреты, SAST, здоровье
зависимостей, ослабление тестов и дельта Slop Index. Модель не вызывается,
сеть не используется. Один вердикт и один код возврата для CI.

Опции:
      --base <ref>          сравнить с ref (git diff ref...HEAD)
      --staged              проверить staged-изменения
      --unstaged            проверить unstaged-изменения
      --include-untracked   включить неотслеживаемые файлы
      --diff <file>         готовый unified diff вместо git-состояния
      --since <ref>         база для дельты slop (по умолчанию HEAD)
      --max-delta <n>       допустимый рост Slop Index (по умолчанию 10)
      --fail-on-issue <lvl> порог SAST и зависимостей: high, medium или low (по умолчанию high)
      --no-secret-scan      не проверять секреты
      --no-sast             не запускать SAST
      --no-deps             не проверять зависимости
      --no-tests            не искать ослабление тестов
      --no-slop             не считать дельту Slop Index
${COMMON_HELP}

Примеры:
  oc-pilot preflight
  oc-pilot preflight --base main --max-delta 0
  oc-pilot preflight --staged --json
  oc-pilot preflight --no-slop --fail-on-issue medium`;

function parseGate(raw: string | undefined): DepSeverity {
  if (raw === undefined || raw.trim() === "") return "high";
  const value = raw.trim().toLowerCase();
  if (value === "high" || value === "medium" || value === "low") return value;
  throw new PilotError(`Некорректный порог --fail-on-issue: ${raw}`, {
    hint: "Допустимые значения: high, medium, low.",
    exitCode: 2,
  });
}

function optionalNumber(values: ArgsValues, key: string): number | undefined {
  const raw = asString(values, key);
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new PilotError(`Некорректное значение --${key}: ${raw}`, {
      hint: "Ожидается число.",
      exitCode: 2,
    });
  }
  return parsed;
}

export async function runPreflight(argv: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const ctx = resolveContext(values);
  const disabled: PreflightCheckId[] = [];
  if (asBoolean(values, "no-secret-scan")) disabled.push("secrets");
  if (asBoolean(values, "no-sast")) disabled.push("sast");
  if (asBoolean(values, "no-deps")) disabled.push("deps");
  if (asBoolean(values, "no-tests")) disabled.push("tests");
  if (asBoolean(values, "no-slop")) disabled.push("slop");

  const data = await loadDiff(values, ctx, positionals, { optionalGit: true });

  const gate = parseGate(asString(values, "fail-on-issue"));
  const report = collectPreflight(ctx.cwd, data, {
    disabled,
    depsGate: gate,
    sastGate: gate,
    maxSlopDelta: optionalNumber(values, "max-delta"),
    since: asString(values, "since"),
  });

  const text = ctx.flags.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : renderPreflight(report);
  const wrote = writeOutput(text, ctx.flags.output);
  if (wrote) log.success(`Отчёт сохранён: ${wrote}`);

  return report.status === "fail" ? 1 : 0;
}
