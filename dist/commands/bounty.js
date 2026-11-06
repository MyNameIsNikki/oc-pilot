import { buildBounty, describeBounty } from "../core/bounty.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString, parsePositiveInt } from "../core/parse.js";
const OPTIONS = withCommon({
    limit: { type: "string" },
    "since-days": { type: "string" },
});
const HELP = `Использование:
  oc-pilot bounty [опции]

Ищет самый проблемный файл репозитория и рисует ASCII-плакат WANTED.
Очки считаются по детерминированным данным: находки SAST, дубликаты,
мёртвые экспорты, TODO с возрастом и churn без тестов. Модель и сеть
не используются.

Опции:
      --limit <n>       сколько файлов показать в списке (по умолчанию 5, максимум 20)
      --since-days <n>  окно истории для churn и возраста TODO (по умолчанию 30)
${COMMON_HELP}

Примеры:
  oc-pilot bounty
  oc-pilot bounty --limit 10 --since-days 90
  oc-pilot bounty --json
  oc-pilot bounty --output wanted.txt`;
export function renderBounty(report) {
    return `${describeBounty(report)}\n\n${report.poster}`;
}
export async function runBounty(argv) {
    const { values } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(HELP);
        return 0;
    }
    const ctx = resolveContext(values);
    const limitRaw = asString(values, "limit");
    const sinceRaw = asString(values, "since-days");
    const limit = limitRaw ? parsePositiveInt(limitRaw, "limit", 20) : 5;
    const sinceDays = sinceRaw ? parsePositiveInt(sinceRaw, "since-days", 365) : 30;
    const report = buildBounty(ctx.cwd, { limit, sinceDays });
    if (ctx.flags.json) {
        const wrote = writeOutput(JSON.stringify(report, null, 2), ctx.flags.output);
        if (wrote)
            log.success(`Отчёт сохранён: ${wrote}`);
        return 0;
    }
    const wrote = writeOutput(renderBounty(report), ctx.flags.output);
    if (wrote)
        log.success(`Плакат сохранён: ${wrote}`);
    if (report.file)
        log.warn(`Розыск: ${report.file} (${String(report.score)} очков).`);
    return 0;
}
//# sourceMappingURL=bounty.js.map