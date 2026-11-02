import { resolve } from "node:path";
import { runShellCommand } from "../core/command.js";
import { truncateText } from "../core/diff.js";
import { describeDiffSource, loadDiff } from "../core/diff-source.js";
import { PilotError } from "../core/errors.js";
import { readStdin, readTextFile } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";
import { detectProjectType, detectTestCommand } from "../core/project.js";
import { executeRecipe } from "../core/run.js";
import { extractSnippets } from "../core/snippets.js";
const OPTIONS = withCommon({
    command: { type: "string" },
    log: { type: "string" },
    "exit-code": { type: "string" },
    force: { type: "boolean" },
    "no-diff": { type: "boolean" },
    diff: { type: "string" },
    staged: { type: "boolean" },
    base: { type: "string" },
    "include-untracked": { type: "boolean" },
    context: { type: "string" },
    "no-secret-scan": { type: "boolean" },
    "fail-on-secrets": { type: "boolean" },
});
const HELP = `Использование:
  oc-pilot test-fix [опции]

Запускает тесты (или читает готовый лог), объясняет первопричину падения и
предлагает минимальный фикс.

Опции:
      --command <cmd>       команда тестов (иначе автоопределение)
      --log <file|->        готовый вывод тестов; "-" — stdin
      --exit-code <n>       код возврата для --log (по умолчанию 1)
      --force               анализировать даже успешный прогон
      --no-diff             не прикладывать git diff
      --diff <file|->       готовый diff
      --staged              только staged-изменения
      --base <ref>          diff <ref>...HEAD
      --include-untracked   включить новые файлы
      --context <text|@file> дополнительный контекст
      --no-secret-scan      не искать секреты и не редактировать diff
      --fail-on-secrets     exit 3 при critical-секретах
${COMMON_HELP}

Примеры:
  oc-pilot test-fix
  oc-pilot test-fix --command "go test ./..."
  oc-pilot test-fix --log test-output.txt
  npm test 2> failures.log; oc-pilot test-fix --log failures.log
`;
function parseExitCode(raw) {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 255) {
        throw new PilotError(`Некорректный --exit-code: ${raw}`, { exitCode: 2 });
    }
    return value;
}
export async function runTestFix(argv) {
    const { values } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(HELP);
        return 0;
    }
    const ctx = resolveContext(values);
    const noDiff = asBoolean(values, "no-diff");
    if (noDiff && asString(values, "diff") !== undefined) {
        throw new PilotError("--no-diff нельзя комбинировать с --diff", { exitCode: 2 });
    }
    const logFile = asString(values, "log");
    if (logFile === "-" && asString(values, "diff") === "-") {
        throw new PilotError("--log - и --diff - не могут одновременно читать stdin", { exitCode: 2 });
    }
    let output = "";
    let exitCode = 1;
    let timedOut = false;
    let durationMs = 0;
    let commandLabel = "";
    let sourceLabel = "";
    if (logFile !== undefined) {
        output = logFile === "-" ? await readStdin() : readTextFile(resolve(ctx.cwd, logFile), "лог тестов");
        exitCode = asString(values, "exit-code") ? parseExitCode(asString(values, "exit-code")) : 1;
        commandLabel = asString(values, "command") ?? "(готовый лог)";
        sourceLabel = logFile === "-" ? "stdin" : logFile;
        log.step(`Читаю лог тестов: ${sourceLabel}`);
    }
    else {
        const detected = detectTestCommand(ctx.cwd);
        const command = asString(values, "command") ?? ctx.config.testCommand ?? detected?.command;
        if (!command) {
            throw new PilotError("Не удалось определить команду тестов", {
                hint: "Укажите --command \"...\" или добавьте testCommand в .oc-pilot.json.",
                exitCode: 2,
            });
        }
        commandLabel = command;
        sourceLabel = asString(values, "command")
            ? "CLI --command"
            : ctx.config.testCommand
                ? "config testCommand"
                : (detected?.source ?? "auto");
        log.step(`Запуск тестов: ${command} (${sourceLabel})`);
        const result = await runShellCommand(command, ctx.cwd, {
            timeoutMs: ctx.config.timeoutSeconds * 1000,
            verbose: ctx.flags.verbose,
            maxBufferChars: Math.max(200_000, ctx.config.maxOutputChars * 5),
        });
        output = result.output;
        exitCode = result.exitCode;
        timedOut = result.timedOut;
        durationMs = result.durationMs;
        if (timedOut)
            log.warn(`Тесты прерваны по таймауту (${ctx.config.timeoutSeconds} с).`);
        if (exitCode === 0 && !asBoolean(values, "force")) {
            log.success("Тесты прошли (exit 0). Анализ не требуется; используйте --force, чтобы разобрать вывод.");
            return 0;
        }
        const tail = output.trim().split(/\r?\n/).slice(-15).filter(Boolean);
        if (exitCode !== 0 && tail.length > 0) {
            log.detail(`Последние строки вывода (exit ${exitCode}):`);
            for (const line of tail)
                log.detail(line);
        }
    }
    let diffData;
    if (!noDiff) {
        diffData = await loadDiff(values, ctx, [], { optionalGit: true });
    }
    else {
        log.detail("Diff отключён (--no-diff).");
    }
    const outputFile = truncateText(output, ctx.config.maxOutputChars, { mode: "both" });
    const snippets = extractSnippets(output, ctx.cwd);
    const snippetsText = truncateText(snippets.text, 24_000, { mode: "head" });
    const modelSource = logFile !== undefined
        ? logFile === "-"
            ? "stdin (содержимое уже включено в TEST_OUTPUT)"
            : "лог-файл (содержимое уже включено в TEST_OUTPUT)"
        : sourceLabel;
    const contextParts = [
        `TEST_COMMAND: ${commandLabel}`,
        `TEST_SOURCE: ${modelSource}`,
        `EXIT_CODE: ${exitCode}`,
        `DURATION_MS: ${durationMs}`,
        `TIMED_OUT: ${timedOut ? "yes" : "no"}`,
        `TEST_OUTPUT${outputFile.truncated ? " (обрезан)" : ""}:`,
        outputFile.text.trim() || "(вывод пуст)",
    ];
    if (snippets.files.length > 0) {
        contextParts.push(`STACK_SNIPPETS (файлы из стека: ${snippets.files.join(", ")}):`, snippetsText.text.trim());
    }
    if (diffData) {
        contextParts.push(`DIFF_SOURCE: ${describeDiffSource(diffData.source)}`);
        contextParts.push(`DIFF_STATS: ${diffData.stats.files} файл(ов), +${diffData.stats.additions} / -${diffData.stats.deletions}`);
    }
    const userContext = asString(values, "context");
    if (userContext && userContext.trim())
        contextParts.push(`USER_CONTEXT:\n${userContext.trim()}`);
    const diff = diffData?.payloadDiff ?? "";
    const secretFindings = diffData?.findings ?? [];
    const changedFiles = diffData?.changedFiles ?? [];
    return executeRecipe({
        recipe: "test-fix",
        projectType: detectProjectType(ctx.cwd, changedFiles),
        additionalContext: contextParts.join("\n\n"),
        diff,
        secretFindings,
        changedFiles,
        failOnSecrets: asBoolean(values, "fail-on-secrets"),
        noSecretScan: asBoolean(values, "no-secret-scan"),
        meta: {
            testCommand: commandLabel,
            testExitCode: exitCode,
            timedOut,
            ...(diffData ? { source: diffData.source } : {}),
        },
    }, ctx);
}
//# sourceMappingURL=test-fix.js.map