import { describeDiffSource, loadDiff } from "../core/diff-source.js";
import { PilotError } from "../core/errors.js";
import { runGit } from "../core/git.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";
import { detectProjectType } from "../core/project.js";
import { executeRecipeDetailed } from "../core/run.js";
const OPTIONS = withCommon({
    staged: { type: "boolean" },
    unstaged: { type: "boolean" },
    base: { type: "string" },
    diff: { type: "string" },
    stdin: { type: "boolean" },
    context: { type: "string" },
    "no-secret-scan": { type: "boolean" },
    "allow-secrets": { type: "boolean" },
    apply: { type: "boolean" },
});
const HELP = `Использование:
  oc-pilot commit [опции]

  Генерирует commit-сообщение (conventional commits) по diff и опционально коммитит.

  По умолчанию анализируются staged-изменения; --apply коммитит только staged.

Опции:
      --staged              только staged-изменения (по умолчанию)
      --unstaged            только unstaged-изменения
      --base <ref>          diff <ref>...HEAD (для PR)
      --diff <file|->       готовый diff из файла или stdin
      --stdin               читать diff из stdin
      --context <text|@file> дополнительный контекст
      --no-secret-scan      не искать секреты и не редактировать diff
      --allow-secrets       не блокировать --apply при critical-секретах
      --apply               закоммитить staged с готовым сообщением
${COMMON_HELP}

Примеры:
  oc-pilot commit
  oc-pilot commit --apply
  oc-pilot commit --staged --context "релиз 0.7.0"
`;
const MAX_MESSAGE_CHARS = 4_000;
const SOURCE_FLAGS = ["staged", "unstaged", "base", "diff", "stdin"];
const FENCE_RE = /^```[a-z]*\s*\n([\s\S]*?)\n```$/i;
const LABEL_RE = /^(?:commit message|сообщение коммита|сообщение для коммита|коммит)\s*[:：]\s*\n?/i;
const CONTROL_CHARS_RE = /[^\x09\x0A\x20-\x7E\u00A0-\uFFFF]/g;
const BLANK_RUN_RE = /\n{3,}/g;
/** Normalizes a raw model response into a clean commit message. */
export function sanitizeCommitMessage(raw) {
    let text = raw.replace(/\r\n?/g, "\n").trim();
    const fenced = FENCE_RE.exec(text);
    if (fenced)
        text = fenced[1].trim();
    text = text.replace(LABEL_RE, "");
    text = text.replace(CONTROL_CHARS_RE, "");
    text = text.replace(BLANK_RUN_RE, "\n\n");
    text = text
        .split("\n")
        .map((line) => line.replace(/[ \t]+$/, ""))
        .join("\n")
        .trim();
    if (text.length > MAX_MESSAGE_CHARS) {
        const cut = text.slice(0, MAX_MESSAGE_CHARS);
        const lastBreak = cut.lastIndexOf("\n");
        text = (lastBreak > 0 ? cut.slice(0, lastBreak) : cut).trim();
    }
    return text;
}
/** Splits a commit message into subject (first line) and body (the rest). */
export function splitCommitMessage(message) {
    const [subject = "", ...rest] = message.split("\n");
    const body = rest.join("\n").trim();
    return { subject, body };
}
export async function runCommit(argv) {
    const { values, positionals } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(HELP);
        return 0;
    }
    const apply = asBoolean(values, "apply");
    const hasSource = SOURCE_FLAGS.some((flag) => values[flag] !== undefined);
    if (apply && hasSource && !asBoolean(values, "staged")) {
        throw new PilotError("--apply работает только со staged-изменениями (--staged по умолчанию).", { exitCode: 2 });
    }
    if (!hasSource)
        values.staged = true;
    const ctx = resolveContext(values);
    const data = await loadDiff(values, ctx, positionals);
    if (!data.diff.trim()) {
        log.info("Изменений нет — генерировать commit-сообщение не для чего.");
        return 0;
    }
    const parts = [
        `TASK: Сгенерируй commit-сообщение по diff ниже.`,
        `DIFF_SOURCE: ${describeDiffSource(data.source)}`,
        `DIFF_STATS: ${data.stats.files} файл(ов), +${data.stats.additions} / -${data.stats.deletions}`,
    ];
    const recent = runGit(["log", "--oneline", "-n", "10"], ctx.cwd);
    if (recent.status === 0 && recent.stdout.trim()) {
        parts.push(`RECENT_COMMITS (стиль сообщений проекта):\n${recent.stdout.trim()}`);
    }
    const userContext = asString(values, "context");
    if (userContext && userContext.trim()) {
        parts.push(`USER_CONTEXT:\n${userContext.trim()}`);
    }
    const captureCtx = { ...ctx, flags: { ...ctx.flags, json: false, output: undefined } };
    const execution = await executeRecipeDetailed({
        recipe: "commit",
        projectType: detectProjectType(ctx.cwd, data.changedFiles),
        additionalContext: parts.join("\n\n"),
        diff: data.payloadDiff,
        secretFindings: data.findings,
        changedFiles: data.changedFiles,
        noSecretScan: asBoolean(values, "no-secret-scan"),
        meta: { source: data.source },
    }, captureCtx, { capture: true, slicing: false });
    if (ctx.flags.dryRun || execution.exitCode !== 0 || !execution.analysis) {
        return execution.exitCode;
    }
    const message = sanitizeCommitMessage(execution.analysis);
    if (!message) {
        log.error("Модель вернула пустое commit-сообщение.");
        return 1;
    }
    const { subject, body } = splitCommitMessage(message);
    if (subject.length > 100)
        log.warn(`Subject длиннее 100 символов (${subject.length}).`);
    const criticalSecrets = data.findings.filter((finding) => finding.severity === "critical").length;
    const shouldBlock = apply && criticalSecrets > 0 && !asBoolean(values, "allow-secrets");
    if (shouldBlock) {
        log.error(`В diff найдены critical-секреты: ${criticalSecrets}. Коммит заблокирован. Уберите секреты или передайте --allow-secrets.`);
    }
    let committed = null;
    if (apply && !shouldBlock) {
        const commitResult = runGit(["commit", "-F", "-"], ctx.cwd, message);
        if (commitResult.status !== 0) {
            throw new PilotError(`git commit завершился с ошибкой: ${commitResult.stderr || "неизвестная ошибка"}`, {
                hint: "Проверьте staged-изменения (git status) и повторите.",
                exitCode: 1,
            });
        }
        const head = runGit(["rev-parse", "--short", "HEAD"], ctx.cwd);
        committed = head.status === 0 ? head.stdout.trim() : null;
        log.success(`Коммит создан: ${committed ?? "HEAD"}`);
    }
    if (ctx.flags.json) {
        const json = {
            message,
            subject,
            body,
            committed,
            diffSource: data.source,
            stats: data.stats,
            secrets: {
                critical: criticalSecrets,
                warning: data.findings.length - criticalSecrets,
            },
            engine: ctx.config.engine,
            model: ctx.config.model ?? null,
            durationMs: execution.meta?.durationMs ?? null,
        };
        const path = writeOutput(JSON.stringify(json, null, 2), ctx.flags.output);
        if (path)
            log.success(`Результат записан: ${path}`);
    }
    else {
        const path = writeOutput(message, ctx.flags.output);
        if (path)
            log.success(`Commit-сообщение записано: ${path}`);
    }
    return shouldBlock ? 3 : execution.exitCode;
}
//# sourceMappingURL=commit.js.map