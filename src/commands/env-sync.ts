import { analyzeEnvSync, type EnvSyncReport } from "../core/env-sync.js";
import { loadDiff } from "../core/diff-source.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean } from "../core/parse.js";

const OPTIONS: OptionSpec = withCommon({
  diff: { type: "string" },
  staged: { type: "boolean" },
  unstaged: { type: "boolean" },
  base: { type: "string" },
  "include-untracked": { type: "boolean" },
  "fail-on-missing": { type: "boolean" },
});

const HELP = `Использование:
  oc-pilot env-sync [пути] [опции]

Сравнивает переменные окружения, добавленные в diff, с файлами .env и
примерами .env.example. Переменная, которой нет ни в одном .env, считается
пропущенной; переменная, которая есть в .env, но не описана в примере,
считается недокументированной. Модель и сеть не используются.

Опции:
      --fail-on-missing   код 1, если переменная не найдена в .env
      --diff <file|->     готовый unified diff вместо git-состояния
      --staged            взять staged-изменения
      --unstaged          взять unstaged-изменения
      --base <ref>        дифф <ref>...HEAD
      --include-untracked включить неотслеживаемые файлы
${COMMON_HELP}

Примеры:
  oc-pilot env-sync --staged
  oc-pilot env-sync --base main --fail-on-missing
  oc-pilot env-sync --diff changes.diff --json`;

function renderEnvSync(source: string, report: EnvSyncReport): string {
  const lines = [`Источник: ${source}`, `Переменных в diff: ${String(report.references.length)}.`];
  if (report.envFiles.length === 0) {
    lines.push("Файлы .env не найдены.");
  } else {
    lines.push(`Файлы окружения: ${report.envFiles.join(", ")}.`);
  }
  if (report.exampleFiles.length > 0) {
    lines.push(`Примеры: ${report.exampleFiles.join(", ")}.`);
  }
  if (report.missing.length > 0) {
    lines.push("", "Не хватает в .env:");
    for (const name of report.missing) lines.push(`  ${name}`);
  }
  if (report.undocumented.length > 0) {
    lines.push("", "Не описаны в примере .env.example:");
    for (const name of report.undocumented) lines.push(`  ${name}`);
  }
  if (report.references.length === 0) {
    lines.push("", "Новых переменных окружения в diff нет.");
  } else if (report.missing.length === 0 && report.undocumented.length === 0) {
    lines.push("", "Все новые переменные окружения объявлены и описаны.");
  }
  return `${lines.join("\n")}\n`;
}

export async function runEnvSync(argv: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const ctx = resolveContext(values);
  const data = await loadDiff(values, ctx, positionals);
  if (!data.diff.trim()) {
    log.info("Изменений нет — проверять переменные окружения нечего.");
    return 0;
  }

  const report = analyzeEnvSync(ctx.cwd, data.diff);
  const failed = asBoolean(values, "fail-on-missing") && report.missing.length > 0;

  if (ctx.flags.json) {
    const payload = { source: data.source, ...report };
    const wrote = writeOutput(JSON.stringify(payload, null, 2), ctx.flags.output);
    if (wrote) log.success(`Отчёт сохранён: ${wrote}`);
    if (failed) log.error(`Не хватает переменных окружения: ${report.missing.join(", ")}.`);
    return failed ? 1 : 0;
  }

  const wrote = writeOutput(renderEnvSync(data.source, report), ctx.flags.output);
  if (wrote) log.success(`Отчёт сохранён: ${wrote}`);
  if (report.missing.length > 0) {
    log.warn(`Не хватает в .env: ${String(report.missing.length)}.`);
  }
  if (report.undocumented.length > 0) {
    log.warn(`Не описаны в .env.example: ${String(report.undocumented.length)}.`);
  }
  if (failed) {
    log.error(`Не хватает переменных окружения: ${report.missing.join(", ")}.`);
  }
  return failed ? 1 : 0;
}
