import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildPack } from "../core/pack.js";
import { loadDiff } from "../core/diff-source.js";
import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString, parsePositiveInt } from "../core/parse.js";
const OPTIONS = withCommon({
    diff: { type: "string" },
    staged: { type: "boolean" },
    unstaged: { type: "boolean" },
    base: { type: "string" },
    "include-untracked": { type: "boolean" },
    budget: { type: "string" },
    "test-log": { type: "string" },
    rules: { type: "string" },
});
const HELP = `Использование:
  oc-pilot pack "<задача>" [опции]

Собирает компактный контекст для агента вместо дампа файлов: задачу,
правила проекта, сигнатуры изменённых файлов, связанные файлы из impact,
имена тестов и последний лог падения. Тела функций и комментарии
отбрасываются, бюджет в символах ограничивает итоговый Markdown.

Опции:
      --budget <n>        лимит символов (по умолчанию 20000)
      --test-log <file>   добавить хвост лога упавших тестов
      --rules <file>      свой файл правил вместо .oc-pilot/rules.md
      --diff <file|->     готовый unified diff вместо git-состояния
      --staged            взять staged-изменения
      --unstaged          взять unstaged-изменения
      --base <ref>        дифф <ref>...HEAD
      --include-untracked включить неотслеживаемые файлы
${COMMON_HELP}

Примеры:
  oc-pilot pack "починить расчёт скидки"
  oc-pilot pack "добавить валюту" --staged --budget 12000
  oc-pilot pack "разобрать падение" --test-log test-output.txt --json
  oc-pilot pack "ревью API" --base main -o context.md`;
function readTestLog(cwd, file) {
    if (!file)
        return undefined;
    const path = resolve(cwd, file);
    if (!existsSync(path)) {
        throw new PilotError(`Файл лога не найден: ${file}`, {
            hint: "Укажите путь к сохранённому выводу тестов или уберите --test-log.",
            exitCode: 2,
        });
    }
    try {
        return readFileSync(path, "utf8");
    }
    catch (error) {
        throw new PilotError(`Не удалось прочитать лог: ${file}`, {
            hint: error instanceof Error ? error.message : undefined,
            exitCode: 2,
        });
    }
}
export async function runPack(argv) {
    const { values, positionals } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(HELP);
        return 0;
    }
    const task = positionals.join(" ").trim();
    if (!task) {
        throw new PilotError("Не указана задача для контекста", {
            hint: 'Например: oc-pilot pack "починить расчёт скидки" --staged',
            exitCode: 2,
        });
    }
    const budgetRaw = asString(values, "budget");
    const budget = budgetRaw ? parsePositiveInt(budgetRaw, "budget") : undefined;
    const ctx = resolveContext(values);
    const data = await loadDiff(values, ctx, [], { optionalGit: true });
    const testLog = readTestLog(ctx.cwd, asString(values, "test-log"));
    const report = buildPack(ctx.cwd, {
        task,
        diff: data.diff,
        changedFiles: data.changedFiles,
        budget,
        rulesPath: asString(values, "rules"),
        testLog,
    });
    if (ctx.flags.json) {
        const wrote = writeOutput(JSON.stringify(report, null, 2), ctx.flags.output);
        if (wrote)
            log.success(`Контекст сохранён: ${wrote}`);
        if (report.truncated)
            log.warn(`Контекст урезан до ${String(report.chars)} символов.`);
        return 0;
    }
    const wrote = writeOutput(report.content, ctx.flags.output);
    if (wrote)
        log.success(`Контекст сохранён: ${wrote}`);
    if (report.truncated)
        log.warn(`Контекст урезан до ${String(report.chars)} символов.`);
    return 0;
}
//# sourceMappingURL=pack.js.map