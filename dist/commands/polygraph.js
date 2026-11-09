import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describeDiffSource, loadDiff } from "../core/diff-source.js";
import { PilotError } from "../core/errors.js";
import { runGit } from "../core/git.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";
import { buildPolygraphPrompt, evaluatePolygraph, parsePolygraphClaims, renderPolygraph, } from "../core/polygraph.js";
import { detectProjectType } from "../core/project.js";
import { executeRecipeDetailed } from "../core/run.js";
const OPTIONS = withCommon({
    commit: { type: "string" },
    message: { type: "string" },
    "message-file": { type: "string" },
    claims: { type: "string" },
    diff: { type: "string" },
    stdin: { type: "boolean" },
    staged: { type: "boolean" },
    unstaged: { type: "boolean" },
    base: { type: "string" },
    "include-untracked": { type: "boolean" },
    "fail-on": { type: "string" },
    strict: { type: "boolean" },
});
const HELP = `Использование:
  oc-pilot polygraph --commit HEAD
  oc-pilot polygraph --message "текст PR" [опции diff]
  oc-pilot polygraph --message-file pr.md --base main
  oc-pilot polygraph --claims claims.json --staged

Проверяет утверждения из сообщения коммита или PR против реального diff.
Модель извлекает утверждения, а детерминированные проверки подтверждают
или опровергают их по diff. Статусы: supported, contradicted, unverifiable.
Supported означает согласованность с diff, а не истинность в мире.

Опции:
      --commit <ref>      сообщение и diff указанного коммита
      --message <text>    текст сообщения или PR
      --message-file <f>  прочитать сообщение из файла
      --claims <file>     готовый JSON с утверждениями, без вызова модели
      --diff <file|->     готовый unified diff
      --stdin             читать diff из stdin
      --staged            только staged-изменения
      --unstaged          только unstaged-изменения
      --base <ref>        diff против ветки
      --include-untracked добавить неотслеживаемые файлы
      --fail-on <level>   contradicted (по умолчанию) или unverifiable
      --strict            то же, что --fail-on unverifiable
${COMMON_HELP}

Коды выхода:
  0  утверждения подтверждены или проверка неполная
  1  есть опровергнутое утверждение (или unverifiable при --strict)
  2  ошибка модели, парсинга или git

Примеры:
  oc-pilot polygraph --commit HEAD
  oc-pilot polygraph --message-file pr.md --base main
  oc-pilot polygraph --claims claims.json --staged --strict`;
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
function parseFailOn(raw, strict) {
    if (raw === undefined || raw.trim() === "")
        return strict ? "unverifiable" : "contradicted";
    const value = raw.trim();
    if (value === "contradicted" || value === "unverifiable")
        return value;
    throw new PilotError(`Неизвестный уровень --fail-on: ${raw}`, {
        hint: "Используйте contradicted или unverifiable.",
        exitCode: 2,
    });
}
function errorReport(source, summary) {
    const report = {
        source,
        claims: [],
        counts: { supported: 0, contradicted: 0, unverifiable: 0 },
        status: "error",
        summary,
        content: "",
    };
    report.content = renderPolygraph(report);
    return report;
}
function commitInputs(cwd, ref) {
    const message = runGit(["show", "-s", "--format=%B", ref], cwd);
    if (message.status !== 0) {
        throw new PilotError(`Не удалось прочитать коммит ${ref}`, {
            hint: message.stderr.trim() || "Проверьте ref.",
            exitCode: 2,
        });
    }
    const patch = runGit(["show", "--format=", "--no-color", "--no-ext-diff", "--first-parent", ref], cwd);
    if (patch.status !== 0) {
        throw new PilotError(`Не удалось получить diff коммита ${ref}`, {
            hint: patch.stderr.trim(),
            exitCode: 2,
        });
    }
    return { message: message.stdout.trim(), diff: patch.stdout, source: `commit ${ref}` };
}
export async function runPolygraph(argv) {
    const { values, positionals } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(`${HELP}\n`);
        return 0;
    }
    if (positionals.length > 0) {
        throw new PilotError("polygraph не принимает позиционных аргументов", {
            hint: "Передайте сообщение через --message, --message-file или --commit.",
            exitCode: 2,
        });
    }
    const ctx = resolveContext(values);
    const commit = asString(values, "commit");
    const message = asString(values, "message");
    const messageFile = asString(values, "message-file");
    const claimsPath = asString(values, "claims");
    const sources = [commit, message, messageFile].filter((value) => Boolean(value));
    if (claimsPath && sources.length > 0) {
        throw new PilotError("Укажите только один источник: --claims или сообщение/--commit", {
            hint: "--claims уже содержит готовые утверждения.",
            exitCode: 2,
        });
    }
    if (!claimsPath && sources.length === 0) {
        throw new PilotError("Нужно указать источник утверждений", {
            hint: "Используйте --commit, --message, --message-file или --claims.",
            exitCode: 2,
        });
    }
    if (sources.length > 1) {
        throw new PilotError("Укажите только один источник сообщения", {
            hint: "Выберите --commit, --message или --message-file.",
            exitCode: 2,
        });
    }
    let source;
    let diff;
    let messageText = "";
    if (commit) {
        const inputs = commitInputs(ctx.cwd, commit);
        source = inputs.source;
        diff = inputs.diff;
        messageText = inputs.message;
    }
    else {
        const data = await loadDiff(values, ctx, [], { optionalGit: true });
        source = describeDiffSource(data.source);
        diff = data.diff;
        if (messageFile)
            messageText = readTextFile(ctx.cwd, messageFile).trim();
        else if (message)
            messageText = message.trim();
    }
    if (!diff.trim()) {
        log.info("Изменений нет — проверять утверждения нечего.");
        return 0;
    }
    let claims;
    if (claimsPath) {
        claims = parsePolygraphClaims(readTextFile(ctx.cwd, claimsPath));
        source = `claims ${claimsPath}`;
    }
    else {
        if (!messageText) {
            throw new PilotError("Сообщение пустое", {
                hint: "Передайте непустой --message, --message-file или --commit.",
                exitCode: 2,
            });
        }
        const result = await executeRecipeDetailed({
            recipe: "custom",
            projectType: detectProjectType(ctx.cwd, []),
            additionalContext: buildPolygraphPrompt(messageText, diff),
            diff: "",
            secretFindings: [],
            changedFiles: [],
            failOnSecrets: false,
            noSecretScan: true,
            meta: { source },
        }, ctx);
        claims = parsePolygraphClaims(result.analysis ?? "");
    }
    if (!claims) {
        const report = errorReport(source, "[POLYGRAPH ERROR]: модель не вернула JSON-утверждения.");
        const wrote = ctx.flags.json
            ? writeOutput(JSON.stringify(report, null, 2), ctx.flags.output)
            : writeOutput(report.content, ctx.flags.output);
        if (wrote)
            log.success(`Отчёт сохранён: ${wrote}`);
        log.error(report.summary);
        return 2;
    }
    const report = evaluatePolygraph(diff, claims, source);
    const wrote = ctx.flags.json
        ? writeOutput(JSON.stringify(report, null, 2), ctx.flags.output)
        : writeOutput(report.content, ctx.flags.output);
    if (wrote)
        log.success(`Отчёт сохранён: ${wrote}`);
    if (report.status === "contradicted")
        log.error(report.summary);
    else if (report.status === "verified")
        log.success(report.summary);
    else
        log.warn(report.summary);
    if (report.status === "error")
        return 2;
    const threshold = parseFailOn(asString(values, "fail-on"), asBoolean(values, "strict"));
    const failed = report.status === "contradicted" ||
        (threshold === "unverifiable" && report.status === "inconclusive");
    return failed ? 1 : 0;
}
//# sourceMappingURL=polygraph.js.map