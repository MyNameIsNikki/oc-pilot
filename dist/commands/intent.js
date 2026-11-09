import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describeDiffSource, loadDiff } from "../core/diff-source.js";
import { PilotError } from "../core/errors.js";
import { buildIntentPrompt, buildSphinxPrompt, evaluateIntent, parseCriteria, parseIntentResults, parseSphinxReport, } from "../core/intent.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";
import { detectProjectType } from "../core/project.js";
import { executeRecipeDetailed } from "../core/run.js";
const OPTIONS = withCommon({
    criteria: { type: "string" },
    "criteria-text": { type: "string" },
    request: { type: "string" },
    "request-file": { type: "string" },
    context: { type: "string" },
    strict: { type: "boolean" },
    diff: { type: "string" },
    stdin: { type: "boolean" },
    staged: { type: "boolean" },
    unstaged: { type: "boolean" },
    base: { type: "string" },
    "include-untracked": { type: "boolean" },
});
const HELP = `Использование:
  oc-pilot intent check --criteria criteria.md [опции diff]
  oc-pilot intent sphinx --request "текст задачи"

check проверяет критерии приёмки против diff: met, partial, unmet,
unverifiable. sphinx допрашивает требования до кода и печатает вопросы,
допущения и тестируемые критерии.
Модель обязательна; детерминированных проверок здесь нет.

Опции:
      --criteria <file>      файл с критериями (check)
      --criteria-text <text> критерии текстом (check)
      --request <text>       текст задачи (sphinx)
      --request-file <file>  файл с задачей (sphinx)
      --context <text>       дополнительный контекст
      --strict               check падает и на partial/unverifiable
      --diff <file|->        готовый unified diff
      --stdin                читать diff из stdin
      --staged               только staged-изменения
      --unstaged             только unstaged-изменения
      --base <ref>           diff против ветки
      --include-untracked    добавить неотслеживаемые файлы
${COMMON_HELP}

Коды выхода check:
  0  все критерии met
  1  есть unmet (или partial/unverifiable при --strict)
  2  ошибка модели или входа

Коды выхода sphinx:
  0  вопросов и допущений нет
  1  [REQUIREMENTS AMBIGUOUS]
  2  ошибка модели

Примеры:
  oc-pilot intent check --criteria docs/acceptance.md --staged
  oc-pilot intent check --criteria-text "- [ ] reset token expires" --base main
  oc-pilot intent sphinx --request "добавить сброс пароля по email"`;
function readTextFile(cwd, path) {
    try {
        return readFileSync(resolve(cwd, path), "utf8");
    }
    catch {
        throw new PilotError(`Не удалось прочитать ${path}`, {
            hint: "Проверьте путь к файлу.",
            exitCode: 2,
        });
    }
}
function intentError(source, message) {
    return {
        source,
        results: [],
        counts: { met: 0, partial: 0, unmet: 0, unverifiable: 0 },
        status: "error",
        summary: message,
        content: `Intent: error\n${message}\n`,
    };
}
function sphinxError(message) {
    return {
        status: "error",
        questions: [],
        assumptions: [],
        criteria: [],
        summary: message,
        content: `Sphinx: error\n${message}\n`,
    };
}
export async function runIntent(argv) {
    const { values, positionals } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(`${HELP}\n`);
        return 0;
    }
    const subcommand = positionals[0] ?? "check";
    if (subcommand !== "check" && subcommand !== "sphinx") {
        throw new PilotError("Неизвестная подкоманда intent", {
            hint: "Доступно: check, sphinx.",
            exitCode: 2,
        });
    }
    const ctx = resolveContext(values);
    if (subcommand === "sphinx") {
        const requestFile = asString(values, "request-file");
        const request = requestFile
            ? readTextFile(ctx.cwd, requestFile).trim()
            : (asString(values, "request") ?? "").trim();
        if (!request) {
            throw new PilotError("Нужен текст задачи", {
                hint: "Передайте --request или --request-file.",
                exitCode: 2,
            });
        }
        const result = await executeRecipeDetailed({
            recipe: "custom",
            projectType: detectProjectType(ctx.cwd, []),
            additionalContext: buildSphinxPrompt(request, asString(values, "context")),
            diff: "",
            secretFindings: [],
            changedFiles: [],
            failOnSecrets: false,
            noSecretScan: true,
            meta: { source: "sphinx" },
        }, ctx);
        const report = parseSphinxReport(result.analysis ?? "");
        if (!report) {
            const error = sphinxError("[SPHINX ERROR]: модель не вернула JSON с вопросами и критериями.");
            const wrote = ctx.flags.json
                ? writeOutput(JSON.stringify(error, null, 2), ctx.flags.output)
                : writeOutput(error.content, ctx.flags.output);
            if (wrote)
                log.success(`Результат сохранён: ${wrote}`);
            log.error(error.summary);
            return 2;
        }
        const wrote = ctx.flags.json
            ? writeOutput(JSON.stringify(report, null, 2), ctx.flags.output)
            : writeOutput(report.content, ctx.flags.output);
        if (wrote)
            log.success(`Результат сохранён: ${wrote}`);
        if (report.status === "ambiguous") {
            log.warn(report.summary);
            return 1;
        }
        log.success(report.summary);
        return 0;
    }
    const criteriaFile = asString(values, "criteria");
    const criteriaText = criteriaFile
        ? readTextFile(ctx.cwd, criteriaFile)
        : (asString(values, "criteria-text") ?? "");
    const criteria = parseCriteria(criteriaText);
    if (criteria.length === 0) {
        throw new PilotError("Нужны критерии приёмки", {
            hint: "Передайте --criteria <file> или --criteria-text.",
            exitCode: 2,
        });
    }
    const data = await loadDiff(values, ctx, [], { optionalGit: true });
    if (!data.diff.trim()) {
        log.info("Изменений нет — проверять критерии не по чему.");
        return 0;
    }
    const source = describeDiffSource(data.source);
    const result = await executeRecipeDetailed({
        recipe: "custom",
        projectType: detectProjectType(ctx.cwd, data.changedFiles),
        additionalContext: buildIntentPrompt(criteria, data.diff, asString(values, "context")),
        diff: "",
        secretFindings: [],
        changedFiles: [],
        failOnSecrets: false,
        noSecretScan: true,
        meta: { source },
    }, ctx);
    const parsed = parseIntentResults(result.analysis ?? "", criteria);
    if (!parsed) {
        const error = intentError(source, "[INTENT ERROR]: модель не вернула JSON с оценками критериев.");
        const wrote = ctx.flags.json
            ? writeOutput(JSON.stringify(error, null, 2), ctx.flags.output)
            : writeOutput(error.content, ctx.flags.output);
        if (wrote)
            log.success(`Результат сохранён: ${wrote}`);
        log.error(error.summary);
        return 2;
    }
    const report = evaluateIntent(criteria, parsed, source);
    const wrote = ctx.flags.json
        ? writeOutput(JSON.stringify(report, null, 2), ctx.flags.output)
        : writeOutput(report.content, ctx.flags.output);
    if (wrote)
        log.success(`Результат сохранён: ${wrote}`);
    if (report.status === "unmet") {
        log.error(report.summary);
        return 1;
    }
    if (asBoolean(values, "strict") && report.status !== "met") {
        log.error(report.summary);
        return 1;
    }
    if (report.status === "met")
        log.success(report.summary);
    else
        log.warn(report.summary);
    return 0;
}
//# sourceMappingURL=intent.js.map