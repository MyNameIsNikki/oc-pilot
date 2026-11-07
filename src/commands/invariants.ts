import { describeDiffSource, loadDiff } from "../core/diff-source.js";
import { PilotError } from "../core/errors.js";
import { checkInvariants, readInvariants } from "../core/invariants.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";

const OPTIONS: OptionSpec = withCommon({
  diff: { type: "string" },
  staged: { type: "boolean" },
  unstaged: { type: "boolean" },
  base: { type: "string" },
  "include-untracked": { type: "boolean" },
  strict: { type: "boolean" },
  "fail-on": { type: "string" },
  "no-cache": { type: "boolean" },
});

const HELP = `Использование:
  oc-pilot invariants [опции]

Проверяет diff против смысловых инвариантов из .oc-pilot/invariants.md.
Файл задаёт области (## billing) и правила; строка с [CRITICAL] блокирует
релиз. Модель отвечает строгим JSON, а результат кешируется по хешу diff и
файла инвариантов. Инварианты вне области изменения получают
[SKIPPED: Out of scope] и не тратят вызов модели.

Формат файла:
  ## billing
  - [CRITICAL] Сумма заказа всегда неотрицательна.
  - Валюта хранится в минорных единицах.

Гейт:
  по умолчанию нарушения — предупреждения, код возврата 0;
  нарушение [CRITICAL] или флаг --strict даёт код 3.

Опции:
      --strict            код 3 при любом нарушении, не только CRITICAL
      --fail-on violation то же, что --strict
      --no-cache          не читать и не писать локальный кеш
      --diff <file|->     готовый unified diff
      --staged            только staged-изменения
      --unstaged          только unstaged-изменения
      --base <ref>        diff <ref>...HEAD
      --include-untracked включить неотслеживаемые файлы
${COMMON_HELP}

Примеры:
  oc-pilot invariants --staged
  oc-pilot invariants --staged --fail-on violation
  oc-pilot invariants --base main --strict --json
  oc-pilot invariants --staged --no-cache --output invariants.txt`;

export async function runInvariants(argv: string[]): Promise<number> {
  const { values } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const ctx = resolveContext(values);
  const loaded = readInvariants(ctx.cwd);
  if (!loaded || loaded.items.length === 0) {
    log.info("Инварианты не заданы: создайте .oc-pilot/invariants.md со списком правил.");
    return 0;
  }

  const data = await loadDiff(values, ctx, [], { optionalGit: true });
  if (!data.diff.trim()) {
    log.info("Изменений нет — проверять инварианты не нужно.");
    return 0;
  }

  const failOn = asString(values, "fail-on");
  if (failOn !== undefined && failOn !== "violation") {
    throw new PilotError(`Неизвестное значение --fail-on: ${failOn}`, {
      hint: "Доступно только: violation.",
      exitCode: 2,
    });
  }
  const strict = asBoolean(values, "strict") || failOn === "violation";

  const report = await checkInvariants(
    ctx.cwd,
    ctx,
    {
      diff: data.diff,
      payloadDiff: data.payloadDiff,
      changedFiles: data.changedFiles,
      findings: data.findings,
      source: describeDiffSource(data.source),
    },
    { strict, noCache: asBoolean(values, "no-cache") },
  );

  if (report.cacheHit) log.detail("Инварианты: использован локальный кеш.");
  if (ctx.flags.json) {
    const wrote = writeOutput(JSON.stringify(report, null, 2), ctx.flags.output);
    if (wrote) log.success(`Отчёт сохранён: ${wrote}`);
  } else {
    const wrote = writeOutput(report.content, ctx.flags.output);
    if (wrote) log.success(`Отчёт сохранён: ${wrote}`);
  }

  if (report.violations > 0) {
    log.warn(`Нарушений: ${String(report.violations)}, из них CRITICAL: ${String(report.criticalViolations)}.`);
  }
  if (report.exitCode === 3) log.error("Инварианты нарушены: гейт блокирует изменение.");
  return report.exitCode;
}
