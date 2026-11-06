import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DEFAULT_BOUNDARY_CONFIG,
  STARTER_BOUNDARY_CONFIG,
  analyzeBoundaries,
  describeBoundaryViolations,
  loadBoundaryConfig,
  type BoundaryReport,
} from "../core/boundaries.js";
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
  config: { type: "string" },
  "fail-on-violation": { type: "boolean" },
  init: { type: "boolean" },
});

const HELP = `Использование:
  oc-pilot boundaries [пути] [опции]

Проверяет, что добавленные импорты не пересекают границы слоёв.
Правила лежат в .oc-pilot/architecture.json: from задаёт файлы-источники,
deny — запрещённые пути или пакеты. Понимает относительные импорты,
require и динамический import. Модель и сеть не используются.

Опции:
      --config <file>        путь к файлу архитектуры
      --init                 создать стартовый .oc-pilot/architecture.json
      --fail-on-violation    код 1, если найдено нарушение
      --diff <file>          готовый unified diff
      --staged               только staged-изменения
      --unstaged             только unstaged-изменения
      --base <ref>           diff <ref>...HEAD
      --include-untracked    добавить неотслеживаемые файлы
${COMMON_HELP}

Примеры:
  oc-pilot boundaries --init
  oc-pilot boundaries --staged
  oc-pilot boundaries --base main --fail-on-violation
  oc-pilot boundaries --diff changes.diff --json`;

function renderBoundaries(source: string, configPath: string, report: BoundaryReport): string {
  const lines = [
    `Источник: ${source}`,
    `Конфиг: ${configPath}`,
    `Правил: ${String(report.rules)}, файлов с импортами: ${String(report.scannedFiles)}.`,
    report.violations.length === 0
      ? "Нарушений границ не найдено."
      : `Нарушений: ${String(report.violations.length)}.`,
  ];
  if (report.violations.length > 0) lines.push("", describeBoundaryViolations(report.violations));
  return `${lines.join("\n")}\n`;
}

export async function runBoundaries(argv: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const explicitConfig = asString(values, "config");
  if (asBoolean(values, "init")) {
    const path = explicitConfig ?? DEFAULT_BOUNDARY_CONFIG;
    const absolute = join(process.cwd(), path);
    if (existsSync(absolute)) {
      throw new PilotError(`Файл архитектуры уже существует: ${path}`, { exitCode: 2 });
    }
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, STARTER_BOUNDARY_CONFIG, "utf8");
    log.success(`Создан ${path}`);
    return 0;
  }

  const ctx = resolveContext(values);
  const config = loadBoundaryConfig(ctx.cwd, explicitConfig);
  if (!config) {
    throw new PilotError("Файл архитектуры не найден", {
      hint: "Создайте его командой oc-pilot boundaries --init и опишите правила слоёв.",
      exitCode: 2,
    });
  }

  const data = await loadDiff(values, ctx, positionals);
  if (!data.diff.trim()) {
    log.info("Изменений нет — проверять границы нечего.");
    return 0;
  }

  const report = analyzeBoundaries(data.diff, config);
  const failed = asBoolean(values, "fail-on-violation") && report.violations.length > 0;
  const configPath = explicitConfig ?? DEFAULT_BOUNDARY_CONFIG;

  if (ctx.flags.json) {
    const wrote = writeOutput(
      JSON.stringify(
        {
          source: data.source,
          config: configPath,
          ...report,
          gate: { failOnViolation: asBoolean(values, "fail-on-violation"), passed: !failed },
        },
        null,
        2,
      ),
      ctx.flags.output,
    );
    if (wrote) log.success(`Отчёт сохранён: ${wrote}`);
    if (failed) log.error(`Нарушений границ: ${String(report.violations.length)}.`);
    return failed ? 1 : 0;
  }

  const wrote = writeOutput(renderBoundaries(data.source, configPath, report), ctx.flags.output);
  if (wrote) log.success(`Отчёт сохранён: ${wrote}`);
  if (report.violations.length > 0) {
    log.warn(`Нарушений границ: ${String(report.violations.length)}.`);
  }
  if (failed) log.error("Импорт пересекает запрещённую границу слоёв.");
  return failed ? 1 : 0;
}
