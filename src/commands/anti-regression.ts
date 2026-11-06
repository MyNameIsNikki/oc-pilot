import { analyzeAntiRegression, describeAntiRegression, requireGitRepository, type AntiRegressionReport } from "../core/anti-regression.js";
import { loadDiff } from "../core/diff-source.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean, asString, parsePositiveInt } from "../core/parse.js";

const OPTIONS: OptionSpec = withCommon({
  diff: { type: "string" },
  staged: { type: "boolean" },
  unstaged: { type: "boolean" },
  base: { type: "string" },
  "include-untracked": { type: "boolean" },
  "max-commits": { type: "string" },
  since: { type: "string" },
  "fail-on-regression": { type: "boolean" },
});

const HELP = `Использование:
  oc-pilot anti-regression [пути] [опции]

Сравнивает добавленные строки с историей git. Если человек уже удалял
такую же строку из этого файла, команда показывает удаливший коммит:
агент не должен молча возвращать удалённую логику или импорт.
Сравнение текстовое, с нормализацией пробелов; тесты и сгенерированные
файлы пропускаются. Модель и сеть не используются.

Опции:
      --max-commits <n>     глубина истории на файл (по умолчанию 200)
      --since <date>        смотреть коммиты начиная с даты или ссылки
      --fail-on-regression  код 1, если найдена повторно добавленная строка
      --diff <file|->       готовый unified diff
      --staged              взять staged-изменения
      --unstaged            взять unstaged-изменения
      --base <ref>          diff <ref>...HEAD
      --include-untracked   включить неотслеживаемые файлы
${COMMON_HELP}

Примеры:
  oc-pilot anti-regression --staged
  oc-pilot anti-regression --base main --fail-on-regression
  oc-pilot anti-regression --diff changes.diff --json`;

function renderAntiRegression(source: string, report: AntiRegressionReport): string {
  const lines = [
    `Источник: ${source}`,
    `Файлов: ${String(report.files.length)}, проверено строк: ${String(report.checkedLines)}.`,
  ];
  if (report.findings.length === 0) {
    lines.push("Повторно добавленных удалённых строк не найдено.");
  } else {
    lines.push(`Повторно добавленных строк: ${String(report.findings.length)}.`, "");
    lines.push(describeAntiRegression(report.findings));
  }
  return `${lines.join("\n")}\n`;
}

export async function runAntiRegression(argv: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const ctx = resolveContext(values);
  requireGitRepository(ctx.cwd);
  const data = await loadDiff(values, ctx, positionals);
  if (!data.diff.trim()) {
    log.info("Изменений нет — проверять антирегрессию нечего.");
    return 0;
  }

  const maxRaw = asString(values, "max-commits");
  const maxCommits = maxRaw ? parsePositiveInt(maxRaw, "max-commits", 5000) : 200;
  const since = asString(values, "since");
  const report = analyzeAntiRegression(ctx.cwd, data.diff, { maxCommits, since });
  const failOnRegression = asBoolean(values, "fail-on-regression");
  const failed = failOnRegression && report.findings.length > 0;

  if (ctx.flags.json) {
    const payload = {
      source: data.source,
      ...report,
      gate: { failOnRegression, passed: !failed },
    };
    const wrote = writeOutput(JSON.stringify(payload, null, 2), ctx.flags.output);
    if (wrote) log.success(`Отчёт сохранён: ${wrote}`);
    if (failed) log.error(`Найдено повторно добавленных строк: ${String(report.findings.length)}.`);
    return failed ? 1 : 0;
  }

  const wrote = writeOutput(renderAntiRegression(data.source, report), ctx.flags.output);
  if (wrote) log.success(`Отчёт сохранён: ${wrote}`);
  if (report.findings.length > 0) {
    log.warn(`Повторно добавленных строк: ${String(report.findings.length)}. Проверьте удалившие коммиты.`);
  }
  if (failed) log.error("Антирегрессионный гейт не пройден.");
  return failed ? 1 : 0;
}
