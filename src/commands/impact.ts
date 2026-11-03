import { loadDiff } from "../core/diff-source.js";
import { analyzeImpact, describeImpact } from "../core/impact.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean } from "../core/parse.js";

const OPTIONS: OptionSpec = withCommon({
  staged: { type: "boolean" },
  unstaged: { type: "boolean" },
  base: { type: "string" },
  diff: { type: "string" },
  stdin: { type: "boolean" },
  "include-untracked": { type: "boolean" },
});

const HELP = `Использование:
  oc-pilot impact [пути] [опции]

Показывает, какие объявления изменил diff и где они ещё используются.
Файлы, которых diff не касался, но которые ссылаются на изменённое имя,
попадают в отчёт — это повод проверить, не забыт ли вызов или ренейм.
Поиск текстовый (без AST): быстро и без зависимостей, но возможны
совпадения в комментариях и строках.

Опции:
      --staged              изменения в индексе (git diff --cached)
      --unstaged            только unstaged-изменения
      --base <ref>          diff против ветки (например, main)
      --diff <file|->       взять патч из файла или stdin
      --stdin               прочитать патч из стандартного ввода
      --include-untracked   добавить новые неотслеживаемые файлы
${COMMON_HELP}

Примеры:
  oc-pilot impact --staged
  oc-pilot impact --base main --json
`;

export async function runImpact(argv: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const ctx = resolveContext(values);
  const data = await loadDiff(values, ctx, positionals);
  if (!data.diff.trim()) {
    log.info("Изменений нет — анализировать нечего.");
    return 0;
  }

  const report = analyzeImpact(ctx.cwd, data.diff, data.changedFiles);
  if (report.symbols.length === 0) {
    log.info("В diff нет новых или изменённых объявлений функций, типов и классов.");
    return 0;
  }

  const untouched = report.references.length;
  log.info(
    `Объявлений: ${report.symbols.length} · ссылок в нетронутых файлах: ${untouched} ` +
      `(проверено файлов: ${report.scannedFiles}).`,
  );

  if (ctx.flags.json) {
    const payload = {
      symbols: report.symbols,
      references: report.references,
      scannedFiles: report.scannedFiles,
      touchedFiles: report.touchedFiles,
    };
    writeOutput(JSON.stringify(payload, null, 2), ctx.flags.output);
    return 0;
  }

  const text = describeImpact(report);
  const wrote = writeOutput(text, ctx.flags.output);
  if (wrote) log.success(`Отчёт записан: ${wrote}`);
  return 0;
}
