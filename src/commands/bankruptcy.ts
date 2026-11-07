import { buildBankruptcy, parseHistoryWindow } from "../core/bankruptcy.js";
import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";

const OPTIONS: OptionSpec = withCommon({
  history: { type: "string" },
  format: { type: "string" },
  explain: { type: "boolean" },
});

const HELP = `Использование:
  oc-pilot bankruptcy [опции]

Детерминированный прогноз техдолга: собирает метрики по последним коммитам
(ослабленные тесты, SAST high/medium, TODO, churn и slop-прокси), сглаживает
их скользящим средним за 14 дней, выбрасывает выбросы и строит линейную
регрессию. Дата, когда балл достигнет 100, — прогноз «банкротства».
Модель и сеть не используются.

Опции:
      --history <30d>        окно истории: 30d, 2w, 3m или число дней (по умолчанию 90)
      --format <text|json|svg> формат вывода (по умолчанию text)
      --explain              показать формулу, веса и правила сглаживания
${COMMON_HELP}

Примеры:
  oc-pilot bankruptcy --history 30d
  oc-pilot bankruptcy --history 30d --format json
  oc-pilot bankruptcy --history 90d --format svg --output debt.svg
  oc-pilot bankruptcy --history 60d --explain`;

export async function runBankruptcy(argv: string[]): Promise<number> {
  const { values } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const format = (asString(values, "format") ?? "text").trim().toLowerCase();
  if (format !== "text" && format !== "json" && format !== "svg") {
    throw new PilotError(`Неизвестный формат: ${format}`, {
      hint: "Доступно: text, json, svg.",
      exitCode: 2,
    });
  }

  const ctx = resolveContext(values);
  const report = buildBankruptcy(ctx.cwd, {
    historyDays: parseHistoryWindow(asString(values, "history")),
    explain: asBoolean(values, "explain"),
  });

  const text = format === "json" ? `${JSON.stringify(report, null, 2)}\n` : format === "svg" ? report.svg : report.content;
  const wrote = writeOutput(text, ctx.flags.output);
  if (wrote) log.success(`Отчёт сохранён: ${wrote}`);
  if (report.insufficient) log.warn("Недостаточно коммитов для прогноза Slop Velocity.");
  else if (report.forecastDate) log.warn(`Прогноз банкротства: ${report.forecastDate}.`);
  return 0;
}
