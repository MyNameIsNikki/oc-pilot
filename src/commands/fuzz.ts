import { loadDiff } from "../core/diff-source.js";
import { PilotError } from "../core/errors.js";
import { runFuzz } from "../core/fuzz.js";
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
  duration: { type: "string" },
  "memory-limit": { type: "string" },
  "max-targets": { type: "string" },
  "fail-on-crash": { type: "boolean" },
});

const HELP = `Использование:
  oc-pilot fuzz [опции]

Ищет новые экспортируемые функции в diff и вызывает их с мусорными
входами: null, undefined, -1, 0, пустая строка, строка на 10 МБ, объект
с __proto__, пустые массив и объект. Каждая функция запускается в
отдельном процессе с жёстким таймаутом и ограничением кучи; файлы с
импортами fs, net, http, https, child_process, fetch или process.env
не запускаются и помечаются [BLOCKED]. Модель не вызывается.

Опции:
      --duration <2s|500ms>  общий бюджет фаззинга (по умолчанию 2s)
      --memory-limit <128MB> лимит кучи на процесс (по умолчанию 128MB)
      --max-targets <n>      максимум функций (по умолчанию 10)
      --fail-on-crash        код 1, если найдено падение
      --diff <file|->        готовый unified diff
      --staged               только staged-изменения
      --unstaged             только unstaged-изменения
      --base <ref>           diff <ref>...HEAD
      --include-untracked    включить неотслеживаемые файлы
${COMMON_HELP}

Примеры:
  oc-pilot fuzz --duration 2s --memory-limit 128MB
  oc-pilot fuzz --staged --fail-on-crash
  oc-pilot fuzz --base main --max-targets 5 --json
  oc-pilot fuzz --duration 10s --output fuzz.txt`;

function parseDuration(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const match = /^(\d+(?:\.\d+)?)(ms|s)?$/i.exec(raw.trim());
  if (!match?.[1]) {
    throw new PilotError(`Некорректная длительность: ${raw}`, {
      hint: "Используйте 2s, 500ms или число миллисекунд.",
      exitCode: 2,
    });
  }
  const value = Number(match[1]);
  return Math.round(match[2]?.toLowerCase() === "ms" ? value : value * 1000);
}

function parseMemory(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const match = /^(\d+)(?:mb)?$/i.exec(raw.trim());
  if (!match?.[1]) {
    throw new PilotError(`Некорректный лимит памяти: ${raw}`, {
      hint: "Используйте 128MB или число мегабайт.",
      exitCode: 2,
    });
  }
  return Number(match[1]);
}

function parseTargets(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 50) {
    throw new PilotError(`Некорректное число целей: ${raw}`, {
      hint: "Допустимо от 1 до 50.",
      exitCode: 2,
    });
  }
  return value;
}

export async function runFuzzCommand(argv: string[]): Promise<number> {
  const { values } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const ctx = resolveContext(values);
  const data = await loadDiff(values, ctx, [], { optionalGit: true });
  if (!data.diff.trim()) {
    log.info("Изменений нет — фаззить нечего.");
    return 0;
  }

  const report = runFuzz(ctx.cwd, data.diff, {
    durationMs: parseDuration(asString(values, "duration")),
    memoryMb: parseMemory(asString(values, "memory-limit")),
    maxTargets: parseTargets(asString(values, "max-targets")),
    failOnCrash: asBoolean(values, "fail-on-crash"),
  });

  if (ctx.flags.json) {
    const wrote = writeOutput(JSON.stringify(report, null, 2), ctx.flags.output);
    if (wrote) log.success(`Отчёт сохранён: ${wrote}`);
  } else {
    const wrote = writeOutput(report.content, ctx.flags.output);
    if (wrote) log.success(`Отчёт сохранён: ${wrote}`);
  }

  if (report.crashes > 0) log.warn(`Падений: ${String(report.crashes)}.`);
  if (report.blocked > 0) log.detail(`Заблокировано целей: ${String(report.blocked)}.`);
  if (report.exitCode === 1) log.error("Фаззинг нашёл падение: гейт блокирует изменение.");
  return report.exitCode;
}
