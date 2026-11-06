import { analyzeContractDrift, describeContractDrift, type ContractDriftReport, type DriftSeverity } from "../core/contract-drift.js";
import { loadDiff } from "../core/diff-source.js";
import { PilotError } from "../core/errors.js";
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
  "fail-on-drift": { type: "string" },
});

const HELP = `Использование:
  oc-pilot contract-drift [пути] [опции]

Ищет неявную ломку контрактов в diff: удалённые поля, ставшие
обязательными опциональные поля и смену типов в TypeScript-интерфейсах,
Zod-схемах, Prisma-моделях, Pydantic-моделях и JSON Schema. Для каждого
изменения показывает, где поле ещё используется в нетронутых файлах.
Модель не вызывается, сеть не используется.

Опции:
      --fail-on-drift <high|medium>  код 1, если найдена находка не ниже уровня
      --diff <file|->                готовый unified diff вместо git-состояния
      --staged                       взять staged-изменения
      --unstaged                     взять unstaged-изменения
      --base <ref>                   дифф <ref>...HEAD
      --include-untracked            включить неотслеживаемые файлы
${COMMON_HELP}

Примеры:
  oc-pilot contract-drift --staged
  oc-pilot contract-drift --base main --fail-on-drift high
  oc-pilot contract-drift --diff changes.diff --json`;

const RANK: Record<DriftSeverity, number> = { medium: 1, high: 2 };

function parseSeverity(raw: string | undefined): DriftSeverity | undefined {
  if (raw === undefined) return undefined;
  if (raw === "high" || raw === "medium") return raw;
  throw new PilotError(`Некорректный уровень --fail-on-drift: ${raw}`, {
    hint: "Допустимые значения: high, medium.",
    exitCode: 2,
  });
}

function renderContractDrift(source: string, report: ContractDriftReport): string {
  const lines = [
    `Источник: ${source}`,
    `Контрактов проверено: ${String(report.contracts.length)}, файлов просмотрено: ${String(report.scannedFiles)}.`,
  ];
  if (report.findings.length === 0) {
    lines.push("Дрейфа контрактов не найдено.");
  } else {
    lines.push(
      `Найдено расхождений: ${String(report.counts.total)} (high ${String(report.counts.high)}, medium ${String(report.counts.medium)}).`,
      "",
      describeContractDrift(report.findings),
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function runContractDrift(argv: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const failOn = parseSeverity(asString(values, "fail-on-drift"));
  const ctx = resolveContext(values);
  const data = await loadDiff(values, ctx, positionals);
  if (!data.diff.trim()) {
    log.info("Изменений нет — проверять контракты нечего.");
    return 0;
  }

  const report = analyzeContractDrift(ctx.cwd, data.diff, data.changedFiles);
  const failed = failOn !== undefined && report.findings.some((finding) => RANK[finding.severity] >= RANK[failOn]);
  const gate = { failOn, passed: !failed };

  if (ctx.flags.json) {
    const wrote = writeOutput(JSON.stringify({ source: data.source, ...report, gate }, null, 2), ctx.flags.output);
    if (wrote) log.success(`Отчёт сохранён: ${wrote}`);
    if (failed) log.error(`Дрейф контрактов не ниже ${failOn}: ${String(report.findings.length)}.`);
    return failed ? 1 : 0;
  }

  const wrote = writeOutput(renderContractDrift(data.source, report), ctx.flags.output);
  if (wrote) log.success(`Отчёт сохранён: ${wrote}`);
  if (report.findings.length > 0) {
    log.warn(`Расхождений контрактов: ${String(report.findings.length)}. Проверьте потребителей полей.`);
  }
  if (failed) {
    log.error(`Дрейф контрактов не ниже ${failOn}: ${String(report.findings.length)}.`);
  }
  return failed ? 1 : 0;
}
