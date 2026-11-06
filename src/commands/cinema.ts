import { buildCinema, describeCinema } from "../core/cinema.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean, asString, parsePositiveInt } from "../core/parse.js";

const OPTIONS: OptionSpec = withCommon({
  title: { type: "string" },
  "since-days": { type: "string" },
  "max-frames": { type: "string" },
  "no-paths": { type: "boolean" },
  cast: { type: "boolean" },
});

const HELP = `Использование:
  oc-pilot cinema [опции]

Собирает терминальный таймлапс сессии из локальных данных: коммиты,
запуски oc-pilot, вызовы API по дням, последнее ревью и квитанцию.
Модель и сеть не используются. По умолчанию выводится самодостаточная
HTML-страница с плеером; --cast даёт asciinema v2 для терминала.

Опции:
      --since-days <n>   окно истории в днях (по умолчанию 7)
      --max-frames <n>   максимум кадров (по умолчанию 120)
      --title <text>     заголовок отчёта
      --no-paths         скрыть пути и локации находок
      --cast             вывести asciinema v2 вместо HTML
${COMMON_HELP}

Примеры:
  oc-pilot cinema --since-days 30 --output cinema.html
  oc-pilot cinema --cast --output session.cast
  oc-pilot cinema --json`;

export async function runCinema(argv: string[]): Promise<number> {
  const { values } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const ctx = resolveContext(values);
  const sinceRaw = asString(values, "since-days");
  const maxRaw = asString(values, "max-frames");
  const report = buildCinema(ctx.cwd, {
    title: asString(values, "title"),
    sinceDays: sinceRaw ? parsePositiveInt(sinceRaw, "since-days", 365) : 7,
    maxFrames: maxRaw ? parsePositiveInt(maxRaw, "max-frames", 500) : 120,
    noPaths: asBoolean(values, "no-paths"),
    cast: asBoolean(values, "cast"),
  });

  if (ctx.flags.json) {
    const wrote = writeOutput(JSON.stringify(report, null, 2), ctx.flags.output);
    if (wrote) log.success(`Отчёт сохранён: ${wrote}`);
    return 0;
  }

  const wrote = writeOutput(report.content, ctx.flags.output);
  if (wrote) log.success(`Отчёт сохранён: ${wrote}`);
  log.detail(describeCinema(report));
  return 0;
}
