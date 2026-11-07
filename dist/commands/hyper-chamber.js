import { PilotError } from "../core/errors.js";
import { renderHyperChamber, runHyperChamber } from "../core/hyper-chamber.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString, parsePositiveInt } from "../core/parse.js";
const OPTIONS = withCommon({
    days: { type: "string" },
    budget: { type: "string" },
    timeout: { type: "string" },
    "memory-limit": { type: "string" },
});
const HELP = `Использование:
  oc-pilot hyper-chamber run <file> [опции]

Помещает самодостаточный JavaScript или ESM-файл в node:vm и прокручивает
его жизненный цикл: подменяет Date.now, ускоряет таймеры и вызывает GC.
За короткий реальный бюджет файл проживает --days симулированных суток,
а heap снимается через node:v8. Если память устойчиво растёт, команда
печатает [MEMORY LEAK DETECTED] и завершается кодом 1.
Файл должен экспортировать функцию run, tick, main или default;
обычный скрипт оборачивается в функцию и вызывается повторно.
Это эвристика, а не доказательство утечки. Нативный код не поддерживается,
TypeScript запускается только из собранного dist/*.js.

Опции:
      --days <365>           сколько суток симулировать (1..3650)
      --budget <2s>          реальный бюджет прогона (100ms..30s)
      --timeout <2s>         синоним --budget
      --memory-limit <128MB> предел кучи процесса (16..4096MB)
${COMMON_HELP}

Примеры:
  oc-pilot hyper-chamber run scripts/task.mjs
  oc-pilot hyper-chamber run scripts/task.mjs --days 30 --budget 500ms --json
  oc-pilot hyper-chamber run dist/task.js --memory-limit 256MB`;
function parseBudget(raw) {
    if (raw === undefined || raw.trim() === "")
        return undefined;
    const match = /^(\d+(?:\.\d+)?)(ms|s)?$/i.exec(raw.trim());
    if (!match?.[1]) {
        throw new PilotError(`Некорректный бюджет: ${raw}`, {
            hint: "Используйте 2s, 500ms или миллисекунды.",
            exitCode: 2,
        });
    }
    const value = Number(match[1]);
    const ms = match[2]?.toLowerCase() === "ms" ? value : value * 1000;
    return Math.max(100, Math.min(30_000, Math.round(ms)));
}
function parseMemory(raw) {
    if (raw === undefined || raw.trim() === "")
        return undefined;
    const match = /^(\d+)(?:mb)?$/i.exec(raw.trim());
    if (!match?.[1]) {
        throw new PilotError(`Некорректный лимит памяти: ${raw}`, {
            hint: "Используйте 128MB или мегабайты.",
            exitCode: 2,
        });
    }
    return Math.max(16, Math.min(4_096, Number(match[1])));
}
export async function runHyperChamberCommand(argv) {
    const { values, positionals } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(`${HELP}\n`);
        return 0;
    }
    const [subcommand, file] = positionals;
    if (subcommand !== "run" || !file) {
        throw new PilotError("Использование: oc-pilot hyper-chamber run <file>", { exitCode: 2 });
    }
    const ctx = resolveContext(values);
    const daysRaw = asString(values, "days");
    const budgetRaw = asString(values, "budget") ?? asString(values, "timeout");
    const result = runHyperChamber(ctx.cwd, file, {
        days: daysRaw ? parsePositiveInt(daysRaw, "days", 3_650) : undefined,
        budgetMs: parseBudget(budgetRaw),
        memoryMb: parseMemory(asString(values, "memory-limit")),
    });
    const wrote = ctx.flags.json
        ? writeOutput(JSON.stringify(result, null, 2), ctx.flags.output)
        : writeOutput(renderHyperChamber(result), ctx.flags.output);
    if (wrote)
        log.success(`Результат сохранён: ${wrote}`);
    if (result.status === "leak") {
        log.error(result.summary);
        return 1;
    }
    if (result.status === "error" || result.status === "timeout") {
        log.error(result.summary);
        return 1;
    }
    return 0;
}
//# sourceMappingURL=hyper-chamber.js.map