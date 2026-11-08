import { describeDiffSource, loadDiff } from "../core/diff-source.js";
import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";
import { detectProjectType } from "../core/project.js";
import { executeRecipeDetailed } from "../core/run.js";
import { buildSkepticPrompt, parseSkepticHypothesis, parseSkepticTimeout, renderSkeptic, runSkeptic, } from "../core/skeptic.js";
const OPTIONS = withCommon({
    diff: { type: "string" },
    stdin: { type: "boolean" },
    staged: { type: "boolean" },
    unstaged: { type: "boolean" },
    base: { type: "string" },
    "include-untracked": { type: "boolean" },
    command: { type: "string" },
    context: { type: "string" },
    "test-timeout": { type: "string" },
});
const HELP = `Использование:
  oc-pilot skeptic [опции]

Модель получает diff и должна предложить минимальный тест, который падает
на предложенном коде и проходит на HEAD. oc-pilot применяет diff в отдельном
shadow worktree, запускает этот тест и превращает мнение в проверяемый факт.

Статусы:
  clean         тест не подтвердил дефект
  bug           тест падает на diff и проходит на HEAD
  unfalsifiable тест не проходит и на HEAD, гипотеза недоказуема
  error         модель не вернула тест или проверка не запустилась

Опции:
      --diff <file|->     готовый unified diff
      --stdin             читать diff из stdin
      --staged            только staged-изменения
      --unstaged          только unstaged-изменения
      --base <ref>        diff против ветки
      --include-untracked добавить неотслеживаемые файлы
      --command <cmd>     команда теста (по умолчанию node --test {file})
      --context <text>    что именно проверить
      --test-timeout <120s> таймаут одного прогона (1s–600s)
${COMMON_HELP}

Примеры:
  oc-pilot skeptic --staged
  oc-pilot skeptic --diff changes.diff --context "проверь границы скидки"
  oc-pilot skeptic --base main --test-timeout 60s --json`;
export async function runSkepticCommand(argv) {
    const { values, positionals } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(HELP);
        return 0;
    }
    if (positionals.length > 0) {
        throw new PilotError("skeptic не принимает позиционных аргументов", {
            hint: "Передайте diff через --diff, --stdin или git-флаги.",
            exitCode: 2,
        });
    }
    const ctx = resolveContext(values);
    const data = await loadDiff(values, ctx, [], { optionalGit: true });
    if (!data.diff.trim()) {
        log.info("Изменений нет — опровергать нечего.");
        return 0;
    }
    const result = await executeRecipeDetailed({
        recipe: "custom",
        projectType: detectProjectType(ctx.cwd, data.changedFiles),
        additionalContext: buildSkepticPrompt(data.diff, asString(values, "context")),
        diff: "",
        secretFindings: [],
        changedFiles: [],
        failOnSecrets: false,
        noSecretScan: true,
        meta: { source: data.source },
    }, ctx);
    const hypothesis = parseSkepticHypothesis(result.analysis ?? "");
    if (!hypothesis) {
        const report = {
            source: describeDiffSource(data.source),
            status: "error",
            summary: "[SKEPTIC ERROR]: модель не вернула JSON-гипотезу.",
            durationMs: 0,
        };
        if (ctx.flags.json) {
            const wrote = writeOutput(JSON.stringify(report, null, 2), ctx.flags.output);
            if (wrote)
                log.success(`Отчёт сохранён: ${wrote}`);
        }
        else {
            const wrote = writeOutput(renderSkeptic(report), ctx.flags.output);
            if (wrote)
                log.success(`Отчёт сохранён: ${wrote}`);
        }
        log.error(report.summary);
        return 2;
    }
    const report = await runSkeptic(ctx.cwd, data.diff, hypothesis, {
        command: asString(values, "command"),
        timeoutMs: parseSkepticTimeout(asString(values, "test-timeout")),
    });
    report.source = describeDiffSource(data.source);
    if (ctx.flags.json) {
        const wrote = writeOutput(JSON.stringify(report, null, 2), ctx.flags.output);
        if (wrote)
            log.success(`Отчёт сохранён: ${wrote}`);
    }
    else {
        const wrote = writeOutput(renderSkeptic(report), ctx.flags.output);
        if (wrote)
            log.success(`Отчёт сохранён: ${wrote}`);
    }
    if (report.status === "bug")
        log.error(report.summary);
    else if (report.status === "clean")
        log.success(report.summary);
    else
        log.warn(report.summary);
    return report.status === "clean" ? 0 : report.status === "bug" ? 1 : 2;
}
//# sourceMappingURL=skeptic.js.map