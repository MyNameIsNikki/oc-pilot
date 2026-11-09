import { analyzeChronos, renderChronos } from "../core/chronos.js";
import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean, asString, parsePositiveInt } from "../core/parse.js";

const OPTIONS: OptionSpec = withCommon({
  file: { type: "string" },
  limit: { type: "string" },
  since: { type: "string" },
  "fail-on-hotspot": { type: "boolean" },
});

const HELP = `Использование:
  oc-pilot chronos <file> [опции]
  oc-pilot chronos --file <file> [опции]

Читает историю файла: коммиты, fix/revert/incident/security-маркеры,
churn, антитела и вакцины. Считает hotspot score и печатает [HOTSPOT],
если файл часто чинили, откатывали или упоминали в инцидентах.
Модель и сеть не используются.

Опции:
      --file <file>        файл для анализа
      --limit <20>         последних коммитов (1–200)
      --since <date>       ограничить историю датой git
      --fail-on-hotspot    код 1 при [HOTSPOT]
${COMMON_HELP}

Коды выхода:
  0  файл не hotspot
  1  [HOTSPOT] при --fail-on-hotspot
  2  ошибка git или аргументов

Примеры:
  oc-pilot chronos src/auth.ts
  oc-pilot chronos --file src/auth.ts --limit 50 --fail-on-hotspot`;

export async function runChronos(argv: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  const fileFlag = asString(values, "file");
  if (positionals.length > 1) {
    throw new PilotError("chronos принимает один файл", {
      hint: "Передайте путь позиционно или через --file.",
      exitCode: 2,
    });
  }
  const file = fileFlag ?? positionals[0];
  if (!file) {
    throw new PilotError("Нужен файл для анализа", {
      hint: "Например: oc-pilot chronos src/auth.ts.",
      exitCode: 2,
    });
  }
  if (fileFlag && positionals.length > 0) {
    throw new PilotError("Укажите файл только один раз", {
      hint: "Либо позиционно, либо через --file.",
      exitCode: 2,
    });
  }

  const ctx = resolveContext(values);
  const limitRaw = asString(values, "limit");
  const report = analyzeChronos(ctx.cwd, file, {
    limit: limitRaw ? parsePositiveInt(limitRaw, "limit", 200) : undefined,
    since: asString(values, "since"),
  });

  const wrote = ctx.flags.json
    ? writeOutput(JSON.stringify(report, null, 2), ctx.flags.output)
    : writeOutput(renderChronos(report), ctx.flags.output);
  if (wrote) log.success(`Результат сохранён: ${wrote}`);

  if (report.hotspot) {
    log.warn(report.summary);
    return asBoolean(values, "fail-on-hotspot") ? 1 : 0;
  }
  log.success(report.summary);
  return 0;
}
