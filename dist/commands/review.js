import { asBoolean, asString } from "../core/parse.js";
import { describeDiffSource, loadDiff } from "../core/diff-source.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { detectProjectType } from "../core/project.js";
import { parseFindings } from "../core/findings.js";
import { executeRecipe, executeRecipeDetailed } from "../core/run.js";
import { analysisFindingsToSarifResults, buildSarif } from "../core/sarif.js";
import { writeOutput } from "../core/io.js";
const OPTIONS = withCommon({
    staged: { type: "boolean" },
    unstaged: { type: "boolean" },
    base: { type: "string" },
    diff: { type: "string" },
    stdin: { type: "boolean" },
    "include-untracked": { type: "boolean" },
    context: { type: "string" },
    "no-secret-scan": { type: "boolean" },
    "fail-on-secrets": { type: "boolean" },
});
const HELP = `Использование:
  oc-pilot review [пути...] [опции]

Анализирует изменения, находит баги, уязвимости и нарушения идиом языка.

Опции:
      --staged              только staged-изменения
      --unstaged            только unstaged-изменения
      --base <ref>          diff <ref>...HEAD (для PR)
      --diff <file|->       готовый diff из файла или stdin
      --stdin               читать diff из stdin
      --include-untracked   включить новые файлы (до 200)
      --context <text|@file> дополнительный контекст
      --no-secret-scan      не искать секреты и не редактировать diff
      --fail-on-secrets     exit 3 при critical-секретах
      --format sarif        SARIF 2.1.0 вместо текста (GitHub Code Scanning)
${COMMON_HELP}

Примеры:
  oc-pilot review
  oc-pilot review --staged --fail-on-secrets
  oc-pilot review --base main
  git diff | oc-pilot review --stdin
  oc-pilot review src/wallet.go --context "User.Balance не может быть отрицательным"
  oc-pilot review --base main --format sarif -o oc-pilot.sarif
`;
export async function runReview(argv) {
    const { values, positionals } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(HELP);
        return 0;
    }
    const ctx = resolveContext(values);
    const data = await loadDiff(values, ctx, positionals);
    if (!data.diff.trim()) {
        log.info("Изменений нет — анализировать нечего.");
        return 0;
    }
    const parts = [
        `DIFF_SOURCE: ${describeDiffSource(data.source)}`,
        `DIFF_STATS: ${data.stats.files} файл(ов), +${data.stats.additions} / -${data.stats.deletions}`,
    ];
    if (data.untracked.length > 0) {
        parts.push(`UNTRACKED_FILES (в diff):\n${data.untracked.map((file) => `- ${file}`).join("\n")}`);
    }
    const userContext = asString(values, "context");
    if (userContext && userContext.trim()) {
        parts.push(`USER_CONTEXT:\n${userContext.trim()}`);
    }
    const payload = {
        recipe: "review",
        projectType: detectProjectType(ctx.cwd, data.changedFiles),
        additionalContext: parts.join("\n\n"),
        diff: data.payloadDiff,
        secretFindings: data.findings,
        changedFiles: data.changedFiles,
        failOnSecrets: asBoolean(values, "fail-on-secrets"),
        noSecretScan: asBoolean(values, "no-secret-scan"),
        meta: { source: data.source },
    };
    if (ctx.flags.format !== "sarif") {
        return executeRecipe(payload, ctx);
    }
    const captureCtx = { ...ctx, flags: { ...ctx.flags, json: false, output: undefined } };
    const execution = await executeRecipeDetailed(payload, captureCtx, { capture: true });
    if (ctx.flags.dryRun)
        return execution.exitCode;
    const analysisFindings = execution.analysis ? parseFindings(execution.analysis) : [];
    const sarif = buildSarif(analysisFindingsToSarifResults(analysisFindings, ctx.cwd));
    const path = writeOutput(JSON.stringify(sarif, null, 2), ctx.flags.output);
    if (path)
        log.success(`SARIF записан: ${path}`);
    return execution.exitCode;
}
//# sourceMappingURL=review.js.map