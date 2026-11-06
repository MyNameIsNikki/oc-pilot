import { buildEcho, describeEcho } from "../core/echo.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean, asString, parsePositiveInt } from "../core/parse.js";

const OPTIONS: OptionSpec = withCommon({
  name: { type: "string" },
  "since-days": { type: "string" },
  submit: { type: "boolean" },
  endpoint: { type: "string" },
  svg: { type: "boolean" },
});

const HELP = `Использование:
  oc-pilot echo [опции]

Собирает локальные бейджи о работе агента: коммиты, запуски, вызовы API,
попадания в кеш, находки и статус тестов из квитанции. Бейджи — обычный
самодостаточный SVG, без сети и внешних ресурсов.

С отправкой:
      --name <ник>        имя для таблицы лидеров (по умолчанию anonymous)
      --submit            отправить анонимную статистику на endpoint
      --endpoint <url>    адрес приёмника; обязателен вместе с --submit

Без --submit команда ничего не отправляет и работает офлайн. В payload
попадают только имя, окно в днях и агрегаты; пути, диффы и секреты — нет.

Опции:
      --since-days <n>    окно статистики в днях (по умолчанию 30, максимум 365)
      --svg               вывести только общий SVG-бейдж
${COMMON_HELP}

Примеры:
  oc-pilot echo --name my-team --svg --output badges.svg
  oc-pilot echo --name my-team --since-days 7
  oc-pilot echo --name my-team --submit --endpoint https://example.com/echo
  oc-pilot echo --json`;

export async function runEcho(argv: string[]): Promise<number> {
  const { values } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const ctx = resolveContext(values);
  const sinceRaw = asString(values, "since-days");
  const sinceDays = sinceRaw ? parsePositiveInt(sinceRaw, "since-days", 365) : 30;
  const report = await buildEcho(ctx.cwd, {
    name: asString(values, "name"),
    sinceDays,
    submit: asBoolean(values, "submit"),
    endpoint: asString(values, "endpoint"),
  });

  const failed = report.submitted && !(report.submissionStatus ?? "").startsWith("ok");

  if (ctx.flags.json) {
    const wrote = writeOutput(JSON.stringify(report, null, 2), ctx.flags.output);
    if (wrote) log.success(`Отчёт сохранён: ${wrote}`);
    if (report.submitted) {
      if (failed) log.error(`Отправка не удалась: ${report.submissionStatus ?? "unknown"}.`);
      else log.success(`Статистика отправлена: ${report.submissionStatus ?? "ok"}.`);
    }
    return failed ? 1 : 0;
  }

  const text = asBoolean(values, "svg") ? report.content : `${describeEcho(report)}\n\n${report.content}`;
  const wrote = writeOutput(text, ctx.flags.output);
  if (wrote) log.success(`Бейджи сохранены: ${wrote}`);
  if (report.submitted) {
    if (failed) log.error(`Отправка не удалась: ${report.submissionStatus ?? "unknown"}.`);
    else log.success(`Статистика отправлена: ${report.submissionStatus ?? "ok"}.`);
  }
  return failed ? 1 : 0;
}
