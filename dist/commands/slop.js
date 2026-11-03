import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";
import { analyzeAgainst, analyzeRepository } from "../core/slop/index.js";
import { badgeSvg, describeSlop } from "../core/slop/score.js";
const OPTIONS = withCommon({
    since: { type: "string" },
    "since-days": { type: "string" },
    limit: { type: "string" },
    exclude: { type: "string" },
    "no-blame": { type: "boolean" },
    "max-index": { type: "string" },
    "max-delta": { type: "string" },
    badge: { type: "boolean" },
});
const HELP = `Использование:
  oc-pilot slop [опции]

Slop Index 0-100: насколько репозиторий зарос энтропией от быстрой генерации.
Считается локально по git и файлам, без API-ключа и сети.

Категории:
  дубликаты        одинаковые блоки кода в разных файлах
  мёртвый код      экспорты, которые никто не импортирует
  churn            файлы, которые часто меняются, а тесты - нет
  TODO             TODO/FIXME/HACK/XXX и их возраст через git blame

Опции:
      --since <ref>      сравнить с ревизией: что добавилось и что убрано
      --since-days <n>   окно истории для churn в днях (по умолчанию 30)
      --limit <n>        элементов на категорию в отчёте (1-50, по умолчанию 10)
      --exclude <a,b>    исключить пути (подстрока или glob)
      --no-blame         не вызывать git blame: быстрее, но без возраста TODO
      --max-index <n>    код 3, если индекс больше порога (для CI)
      --max-delta <n>    код 3, если прирост относительно --since больше порога
      --badge            вывести SVG-бейдж вместо текста
${COMMON_HELP}

Примеры:
  oc-pilot slop
  oc-pilot slop --since origin/main --max-delta 10
  oc-pilot slop --badge -o slop.svg
  oc-pilot slop --json -o slop.json --max-index 40`;
function intOption(values, name, fallback, min, max) {
    const raw = asString(values, name);
    if (raw === undefined || raw.trim() === "")
        return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
        throw new PilotError(`Некорректное значение --${name}: ${raw}`, {
            hint: `Ожидается целое число от ${String(min)} до ${String(max)}.`,
            exitCode: 2,
        });
    }
    return parsed;
}
function optionalInt(values, name) {
    const raw = asString(values, name);
    if (raw === undefined || raw.trim() === "")
        return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
        throw new PilotError(`Некорректное значение --${name}: ${raw}`, {
            hint: "Ожидается число.",
            exitCode: 2,
        });
    }
    return parsed;
}
function deltaText(delta) {
    const sign = delta.deltaPoints > 0 ? "+" : "";
    const lines = [
        "",
        `  Δ относительно ${delta.base}: ${sign}${String(delta.deltaPoints)} баллов · добавлено ${String(delta.introduced)}, убрано ${String(delta.removed)}`,
    ];
    for (const category of delta.categories) {
        if (category.introduced === 0 && category.removed === 0)
            continue;
        lines.push(`    ${category.label}  +${String(category.introduced)} / -${String(category.removed)}`);
    }
    return lines.join("\n");
}
function render(report, ctx, limit) {
    if (ctx.flags.json) {
        writeOutput(JSON.stringify(report, null, 2), ctx.flags.output);
        return;
    }
    const wrote = writeOutput(describeSlop(report, limit), ctx.flags.output);
    if (wrote)
        log.success(`Отчёт сохранён: ${wrote}`);
}
export async function runSlop(argv) {
    const { values } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(HELP);
        return 0;
    }
    const ctx = resolveContext(values);
    const limit = intOption(values, "limit", 10, 1, 50);
    const sinceDays = intOption(values, "since-days", 30, 1, 3_650);
    const exclude = (asString(values, "exclude") ?? "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
    const blame = !asBoolean(values, "no-blame");
    const since = asString(values, "since")?.trim();
    const maxIndex = optionalInt(values, "max-index");
    const maxDelta = optionalInt(values, "max-delta");
    const options = { limit, sinceDays, exclude, blame };
    if (since) {
        const { current, delta } = analyzeAgainst(ctx.cwd, since, options);
        if (asBoolean(values, "badge")) {
            writeOutput(badgeSvg(current), ctx.flags.output);
        }
        else if (ctx.flags.json) {
            writeOutput(JSON.stringify({ ...current, delta }, null, 2), ctx.flags.output);
        }
        else {
            const text = `${describeSlop(current, limit)}\n${deltaText(delta)}\n`;
            const wrote = writeOutput(text, ctx.flags.output);
            if (wrote)
                log.success(`Отчёт сохранён: ${wrote}`);
        }
        if (maxDelta !== undefined && delta.deltaPoints > maxDelta) {
            log.warn(`Прирост ${String(delta.deltaPoints)} больше порога --max-delta ${String(maxDelta)}.`);
            return 3;
        }
        return 0;
    }
    const report = analyzeRepository(ctx.cwd, options);
    if (asBoolean(values, "badge")) {
        writeOutput(badgeSvg(report), ctx.flags.output);
    }
    else {
        render(report, ctx, limit);
    }
    if (maxIndex !== undefined && report.index > maxIndex) {
        log.warn(`Индекс ${String(report.index)} больше порога --max-index ${String(maxIndex)}.`);
        return 3;
    }
    return 0;
}
//# sourceMappingURL=slop.js.map