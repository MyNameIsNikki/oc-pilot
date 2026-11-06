import { buildBrag } from "../core/brag.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString, parsePositiveInt } from "../core/parse.js";
const OPTIONS = withCommon({
    title: { type: "string" },
    watermark: { type: "string" },
    "no-paths": { type: "boolean" },
    "since-days": { type: "string" },
    svg: { type: "boolean" },
});
const HELP = `Использование:
  oc-pilot brag [опции]

Собирает локальную страницу-отчёт о работе: коммиты, строки, запуски
oc-pilot, вызовы модели, кеш, находки, последнее ревью и квитанцию HEAD.
HTML самодостаточный: стили и SVG внутри, без сети, шрифтов и картинок.
Секреты и пути не попадают в отчёт; --no-paths скрывает и пути находок.

Опции:
      --title <text>       заголовок страницы
      --watermark <text>   подпись внизу (по умолчанию "made with oc-pilot")
      --no-paths           скрыть пути в списке находок
      --since-days <n>     окно в днях (по умолчанию 7, максимум 365)
      --svg                вывести только SVG-график
${COMMON_HELP}

Примеры:
  oc-pilot brag
  oc-pilot brag --since-days 30 --output brag.html
  oc-pilot brag --svg --output activity.svg
  oc-pilot brag --json`;
export async function runBrag(argv) {
    const { values } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(HELP);
        return 0;
    }
    const ctx = resolveContext(values);
    const rawDays = asString(values, "since-days");
    const sinceDays = rawDays ? parsePositiveInt(rawDays, "since-days", 365) : undefined;
    const options = {
        title: asString(values, "title"),
        watermark: asString(values, "watermark"),
        noPaths: asBoolean(values, "no-paths"),
        sinceDays,
        svg: asBoolean(values, "svg"),
    };
    const report = buildBrag(ctx.cwd, options);
    if (ctx.flags.json) {
        const wrote = writeOutput(JSON.stringify(report, null, 2), ctx.flags.output);
        if (wrote)
            log.success(`Отчёт сохранён: ${wrote}`);
        return 0;
    }
    const wrote = writeOutput(report.content, ctx.flags.output);
    if (wrote)
        log.success(`Отчёт сохранён: ${wrote}`);
    return 0;
}
//# sourceMappingURL=brag.js.map