import { analyzeAutopsy, renderAutopsy } from "../core/autopsy.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean, asString, parsePositiveInt } from "../core/parse.js";

const OPTIONS: OptionSpec = withCommon({
  depth: { type: "string" },
  "fail-on-risk": { type: "boolean" },
});

const HELP = `Использование:
  oc-pilot autopsy [коммит] [опции]

Разбирает один коммит как место происшествия: что изменено, какие
детерминированные проверки сработали на добавленных строках (SAST,
ослабление тестов, заглушки) и какие коммиты трогали те же файлы до и
после. Модель и сеть не используются.

Аргументы:
  коммит                ref для разбора (по умолчанию HEAD)

Опции:
      --depth <n>       сколько соседних коммитов показать по каждому файлу (1-50, по умолчанию 5)
      --fail-on-risk    код 1, если остались high-сигналы
${COMMON_HELP}

Примеры:
  oc-pilot autopsy
  oc-pilot autopsy HEAD~1
  oc-pilot autopsy v0.78.0 --depth 10
  oc-pilot autopsy HEAD --fail-on-risk --json`;

export async function runAutopsy(argv: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const ctx = resolveContext(values);
  const ref = positionals[0] ?? "HEAD";
  const depthRaw = asString(values, "depth");
  const depth = depthRaw ? parsePositiveInt(depthRaw, "depth", 50) : 5;
  const failOnRisk = asBoolean(values, "fail-on-risk");
  const report = analyzeAutopsy(ctx.cwd, ref, { depth });
  const failed = failOnRisk && report.verdict === "dangerous";
  const gate = { failOnRisk, passed: !failed };

  if (ctx.flags.json) {
    const wrote = writeOutput(JSON.stringify({ ...report, gate }, null, 2), ctx.flags.output);
    if (wrote) log.success(`Отчёт сохранён: ${wrote}`);
    if (failed) log.error(`В коммите ${report.commit.shortHash} остались high-сигналы.`);
    return failed ? 1 : 0;
  }

  const wrote = writeOutput(renderAutopsy(report), ctx.flags.output);
  if (wrote) log.success(`Отчёт сохранён: ${wrote}`);
  if (report.verdict === "dangerous") log.warn(`Вердикт: dangerous. ${report.summary}`);
  else if (report.verdict === "suspicious") log.warn(`Вердикт: suspicious. ${report.summary}`);
  if (failed) log.error(`В коммите ${report.commit.shortHash} остались high-сигналы.`);
  return failed ? 1 : 0;
}
