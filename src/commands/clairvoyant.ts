import { analyzeClairvoyant, renderClairvoyant } from "../core/clairvoyant.js";
import { describeDiffSource, loadDiff } from "../core/diff-source.js";
import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean } from "../core/parse.js";

const OPTIONS: OptionSpec = withCommon({
  "fail-on-empty": { type: "boolean" },
  diff: { type: "string" },
  stdin: { type: "boolean" },
  staged: { type: "boolean" },
  unstaged: { type: "boolean" },
  base: { type: "string" },
  "include-untracked": { type: "boolean" },
});

const HELP = `Использование:
  oc-pilot clairvoyant [опции]

Строит карту изменённых файлов и символов, находит тестовые файлы, которые
их импортируют, упоминают или совпадают по имени, и выбирает минимальный
набор тестов для CI. Если предсказанных тестов нет, в scope попадают
кандидаты по имени; если нет и их — нужен полный набор.
Модель и сеть не используются.

Опции:
      --fail-on-empty      код 1, если затронутых тестов не найдено
      --diff <file|->      готовый unified diff
      --stdin              читать diff из stdin
      --staged             только staged-изменения
      --unstaged           только unstaged-изменения
      --base <ref>         diff против ветки
      --include-untracked  добавить неотслеживаемые файлы
${COMMON_HELP}

Примеры:
  oc-pilot clairvoyant --staged
  oc-pilot clairvoyant --base main --fail-on-empty
  oc-pilot clairvoyant --staged --json`;

export async function runClairvoyant(argv: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (positionals.length > 0) {
    throw new PilotError("clairvoyant не принимает позиционных аргументов", {
      hint: "Передайте diff через --diff, --stdin или git-флаги.",
      exitCode: 2,
    });
  }

  const ctx = resolveContext(values);
  const data = await loadDiff(values, ctx, [], { optionalGit: true });
  if (!data.diff.trim()) {
    log.info("Изменений нет — прогнозировать CI нечего.");
    return 0;
  }

  const report = analyzeClairvoyant(ctx.cwd, data.diff);
  const payload = { source: describeDiffSource(data.source), ...report };
  const wrote = ctx.flags.json
    ? writeOutput(JSON.stringify(payload, null, 2), ctx.flags.output)
    : writeOutput(renderClairvoyant(report), ctx.flags.output);
  if (wrote) log.success(`Результат сохранён: ${wrote}`);

  if (report.scope.length === 0) {
    log.warn(report.summary);
    return asBoolean(values, "fail-on-empty") ? 1 : 0;
  }
  log.success(report.summary);
  return 0;
}
