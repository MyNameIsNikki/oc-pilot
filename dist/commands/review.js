import { asBoolean, asString } from "../core/parse.js";
import { describeDiffSource, loadDiff } from "../core/diff-source.js";
import { filterFindings, loadBaseline, writeBaseline } from "../core/baseline.js";
import { runGit } from "../core/git.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { detectProjectType } from "../core/project.js";
import { parseFindings } from "../core/findings.js";
import { executeRecipe, executeRecipeDetailed } from "../core/run.js";
import { buildPrCommentBody, postPrComment } from "../core/pr-comment.js";
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
    router: { type: "boolean" },
    "no-router": { type: "boolean" },
    "router-model": { type: "string" },
    baseline: { type: "boolean" },
    "update-baseline": { type: "boolean" },
    pr: { type: "boolean" },
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
      --router              двухфазный роутинг: дешёвый триаж перед ревью (openai)
      --no-router           отключить роутинг, включённый в конфиге
      --router-model <m>    модель триажа (по умолчанию routerModel из конфига)
      --baseline            фильтровать известные находки из .oc-pilot/baseline.json
      --update-baseline     записать текущие находки в baseline и выйти (код 0)
      --pr                  отправить сводку комментарием в PR (нужен gh)
${COMMON_HELP}

Примеры:
  oc-pilot review
  oc-pilot review --staged --fail-on-secrets
  oc-pilot review --base main
  git diff | oc-pilot review --stdin
  oc-pilot review src/wallet.go --context "User.Balance не может быть отрицательным"
  oc-pilot review --base main --format sarif -o oc-pilot.sarif
  oc-pilot review --staged --baseline --fail-on critical
  oc-pilot review --staged --update-baseline
  oc-pilot review --base main --pr
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
    const updateBaseline = asBoolean(values, "update-baseline");
    const prWanted = asBoolean(values, "pr");
    const baselineWanted = asBoolean(values, "baseline") || updateBaseline;
    const baseline = baselineWanted ? loadBaseline(ctx.cwd) : undefined;
    if (asBoolean(values, "baseline") && baseline && baseline.count === 0) {
        log.warn("Baseline пуст или не найден (.oc-pilot/baseline.json).");
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
        baseline: baseline ? [...baseline.fingerprints] : undefined,
        meta: { source: data.source },
    };
    // Two-phase routing resolution: flag > no-flag > config > disabled.
    const routerModel = asString(values, "router-model") ?? ctx.config.routerModel;
    const routerEnabled = asBoolean(values, "router")
        ? true
        : asBoolean(values, "no-router")
            ? false
            : ctx.config.routerEnabled ?? false;
    const routerOptions = { enabled: routerEnabled, model: routerModel };
    if (ctx.flags.format !== "sarif" && !updateBaseline && !prWanted) {
        return executeRecipe(payload, ctx, { router: routerOptions });
    }
    const capture = ctx.flags.format === "sarif";
    const runCtx = capture ? { ...ctx, flags: { ...ctx.flags, json: false, output: undefined } } : ctx;
    const execution = await executeRecipeDetailed(payload, runCtx, { capture, router: routerOptions });
    if (ctx.flags.dryRun)
        return execution.exitCode;
    const rawFindings = execution.analysis ? parseFindings(execution.analysis) : [];
    if (updateBaseline) {
        const written = writeBaseline(ctx.cwd, rawFindings);
        log.success(`Baseline обновлён: находок ${written.count} → ${written.path}`);
        return 0;
    }
    let findings = rawFindings;
    let knownHidden = 0;
    if (baseline && baseline.count > 0) {
        const filtered = filterFindings(rawFindings, baseline.fingerprints);
        findings = filtered.kept;
        knownHidden = filtered.knownCount;
    }
    if (capture) {
        const sarif = buildSarif(analysisFindingsToSarifResults(findings, ctx.cwd));
        const path = writeOutput(JSON.stringify(sarif, null, 2), ctx.flags.output);
        if (path)
            log.success(`SARIF записан: ${path}`);
    }
    if (prWanted) {
        const shaResult = runGit(["rev-parse", "HEAD"], ctx.cwd);
        const sha = shaResult.status === 0 ? shaResult.stdout.trim() : "";
        postPrComment(buildPrCommentBody(findings, { sha, knownHidden }), ctx.cwd);
        log.success("Комментарий отправлен в PR.");
    }
    return execution.exitCode;
}
//# sourceMappingURL=review.js.map