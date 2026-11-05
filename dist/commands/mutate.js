import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadDiff } from "../core/diff-source.js";
import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { readSource, renderMutation, runMutation } from "../core/mutation.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString, parsePositiveInt } from "../core/parse.js";
import { detectTestCommand } from "../core/project.js";
import { isCodeFile, isGeneratedPath, isTestFile } from "../core/slop/source.js";
const OPTIONS = withCommon({
    command: { type: "string" },
    diff: { type: "string" },
    staged: { type: "boolean" },
    unstaged: { type: "boolean" },
    base: { type: "string" },
    "include-untracked": { type: "boolean" },
    "max-mutants": { type: "string" },
    "min-score": { type: "string" },
});
const HELP = `Использование:
  oc-pilot mutate [пути] [опции]

Мутационное тестирование: команда меняет операторы в изменённом коде
(===, !==, ==, !=, >=, <=, &&, ||, true, false) и после каждой мутации
запускает тесты. Если тесты упали — мутация убита. Если прошли — тест
её не ловит, и это выжившая мутация.

Опции:
      --command <cmd>     команда тестов (иначе testCommand или автоопределение)
      --max-mutants <n>   сколько мутаций проверить (по умолчанию 20)
      --min-score <n>     код 1, если mutation score ниже n (0-100)
      --diff <file>       готовый unified diff вместо git-состояния
      --staged            взять staged-изменения
      --unstaged          взять unstaged-изменения
      --base <ref>        дифф <ref>...HEAD
      --include-untracked включить неотслеживаемые файлы
${COMMON_HELP}

Примеры:
  oc-pilot mutate --staged
  oc-pilot mutate --base main --max-mutants 10
  oc-pilot mutate src/billing.ts --min-score 80
  oc-pilot mutate --diff changes.diff --json`;
export async function runMutate(argv) {
    const { values, positionals } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(HELP);
        return 0;
    }
    const ctx = resolveContext(values);
    const data = await loadDiff(values, ctx, positionals, { optionalGit: true });
    const files = data.changedFiles.filter((path) => isCodeFile(path) && !isTestFile(path) && !isGeneratedPath(path) && existsSync(join(ctx.cwd, path)));
    if (files.length === 0) {
        log.info("Нет изменённых файлов с кодом для мутаций.");
        return 0;
    }
    const command = asString(values, "command") ?? ctx.config.testCommand ?? detectTestCommand(ctx.cwd)?.command;
    if (!command) {
        throw new PilotError("Не найдена команда тестов", {
            hint: "Укажите --command или поле testCommand в .oc-pilot.json.",
            exitCode: 2,
        });
    }
    const maxRaw = asString(values, "max-mutants");
    const maxMutants = maxRaw ? parsePositiveInt(maxRaw, "max-mutants", 500) : 20;
    const minRaw = asString(values, "min-score");
    const minScore = minRaw ? parsePositiveInt(minRaw, "min-score", 100) : undefined;
    const sources = files.map((path) => ({ path, text: readSource(ctx.cwd, path) }));
    const report = await runMutation(ctx.cwd, sources, {
        command,
        maxMutants,
        timeoutMs: ctx.config.timeoutSeconds * 1000,
        onProgress: (mutant, index, total) => {
            log.detail(`Мутация ${String(index)}/${String(total)}: ${mutant.file}:${String(mutant.line)} ${mutant.operator} → ${mutant.replacement} — ${mutant.status}`);
        },
    });
    const failed = minScore !== undefined && report.score !== null && report.score < minScore;
    if (ctx.flags.json) {
        const wrote = writeOutput(JSON.stringify(report, null, 2), ctx.flags.output);
        if (wrote)
            log.success(`Отчёт сохранён: ${wrote}`);
        if (failed)
            log.error(`Mutation score ${String(report.score)} ниже порога ${String(minScore)}.`);
        return failed ? 1 : 0;
    }
    const wrote = writeOutput(renderMutation(report), ctx.flags.output);
    if (wrote)
        log.success(`Отчёт сохранён: ${wrote}`);
    if (report.survived > 0) {
        log.warn(`Выживших мутаций: ${String(report.survived)}. Тесты не ловят эти изменения.`);
    }
    if (failed) {
        log.error(`Mutation score ${String(report.score)} ниже порога ${String(minScore)}.`);
    }
    return failed ? 1 : 0;
}
//# sourceMappingURL=mutate.js.map