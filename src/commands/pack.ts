import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildPack } from "../core/pack.js";
import { buildHologram } from "../core/hologram.js";
import { loadDiff } from "../core/diff-source.js";
import { PilotError } from "../core/errors.js";
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
  budget: { type: "string" },
  hologram: { type: "boolean" },
  "max-tokens": { type: "string" },
  "test-log": { type: "string" },
  rules: { type: "string" },
});

const HELP = `Использование:
  oc-pilot pack "<задача>" [опции]

Собирает компактный контекст для агента вместо дампа файлов: задачу,
правила проекта, сигнатуры изменённых файлов, связанные файлы из impact,
имена тестов и последний лог падения. Тела функций и комментарии
отбрасываются, бюджет в символах ограничивает итоговый Markdown.

С --hologram строится слоистый «голограммный» контекст: файлы из diff
идут целиком, прямые импорты — с вырезанными телами функций и маркерами
побочных эффектов, остальные файлы — только именами экспортов. Скрытое
тело можно достать командой zoom-symbol.

Опции:
      --budget <n>        лимит символов (по умолчанию 20000)
      --hologram          слоистый контекст LOD 0/1/2 вместо обычного pack
      --max-tokens <n>    бюджет голограммы в токенах (по умолчанию 30000)
      --test-log <file>   добавить хвост лога упавших тестов
      --rules <file>      свой файл правил вместо .oc-pilot/rules.md
      --diff <file|->     готовый unified diff вместо git-состояния
      --staged            взять staged-изменения
      --unstaged          взять unstaged-изменения
      --base <ref>        дифф <ref>...HEAD
      --include-untracked включить неотслеживаемые файлы
${COMMON_HELP}

Примеры:
  oc-pilot pack "починить расчёт скидки"
  oc-pilot pack "добавить валюту" --staged --budget 12000
  oc-pilot pack --hologram --max-tokens 30000 --output context.md
  oc-pilot pack "разобрать падение" --test-log test-output.txt --json
  oc-pilot pack "ревью API" --base main -o context.md`;

function readTestLog(cwd: string, file: string | undefined): string | undefined {
  if (!file) return undefined;
  const path = resolve(cwd, file);
  if (!existsSync(path)) {
    throw new PilotError(`Файл лога не найден: ${file}`, {
      hint: "Укажите путь к сохранённому выводу тестов или уберите --test-log.",
      exitCode: 2,
    });
  }
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new PilotError(`Не удалось прочитать лог: ${file}`, {
      hint: error instanceof Error ? error.message : undefined,
      exitCode: 2,
    });
  }
}

export async function runPack(argv: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const ctx = resolveContext(values);
  const data = await loadDiff(values, ctx, [], { optionalGit: true });
  const task = positionals.join(" ").trim();

  if (asBoolean(values, "hologram")) {
    const maxRaw = asString(values, "max-tokens");
    const maxTokens = maxRaw ? parsePositiveInt(maxRaw, "max-tokens", 200_000) : undefined;
    const report = buildHologram(ctx.cwd, {
      task: task || undefined,
      diff: data.diff,
      changedFiles: data.changedFiles,
      maxTokens,
    });
    const bailouts = report.files.filter((file) => file.bailout).length;

    if (ctx.flags.json) {
      const wrote = writeOutput(JSON.stringify(report, null, 2), ctx.flags.output);
      if (wrote) log.success(`Голограмма сохранена: ${wrote}`);
    } else {
      const wrote = writeOutput(report.content, ctx.flags.output);
      if (wrote) log.success(`Голограмма сохранена: ${wrote}`);
    }
    if (report.truncated) log.warn(`Голограмма урезана до ~${String(report.estimatedTokens)} токенов.`);
    if (bailouts > 0) log.warn(`[Hologram: parse bailout] файлов: ${String(bailouts)}.`);
    if (report.secretFindings > 0) log.warn(`Секретов в контексте: ${String(report.secretFindings)} — значения замаскированы.`);
    return 0;
  }

  if (!task) {
    throw new PilotError("Не указана задача для контекста", {
      hint: 'Например: oc-pilot pack "починить расчёт скидки" --staged',
      exitCode: 2,
    });
  }

  const budgetRaw = asString(values, "budget");
  const budget = budgetRaw ? parsePositiveInt(budgetRaw, "budget") : undefined;
  const testLog = readTestLog(ctx.cwd, asString(values, "test-log"));
  const report = buildPack(ctx.cwd, {
    task,
    diff: data.diff,
    changedFiles: data.changedFiles,
    budget,
    rulesPath: asString(values, "rules"),
    testLog,
  });

  if (ctx.flags.json) {
    const wrote = writeOutput(JSON.stringify(report, null, 2), ctx.flags.output);
    if (wrote) log.success(`Контекст сохранён: ${wrote}`);
    if (report.truncated) log.warn(`Контекст урезан до ${String(report.chars)} символов.`);
    return 0;
  }

  const wrote = writeOutput(report.content, ctx.flags.output);
  if (wrote) log.success(`Контекст сохранён: ${wrote}`);
  if (report.truncated) log.warn(`Контекст урезан до ${String(report.chars)} символов.`);
  return 0;
}
