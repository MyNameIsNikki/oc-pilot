import readline from "node:readline/promises";
import { asBoolean, asString } from "../core/parse.js";
import { describeDiffSource, loadDiff } from "../core/diff-source.js";
import {
  appendToBaseline,
  filterAnalysisText,
  filterFindings,
  findingFingerprint,
  loadBaseline,
  writeBaseline,
} from "../core/baseline.js";
import { runGit } from "../core/git.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, type OptionSpec } from "../core/options.js";
import { detectProjectType } from "../core/project.js";
import { parseFindings, shouldFail, severityLabel } from "../core/findings.js";
import { executeRecipe, executeRecipeDetailed, type SecondOpinionPreferences } from "../core/run.js";
import { buildPrCommentBody } from "../core/pr-comment.js";
import { buildInlineComments, postPrReviewSummary, postPrStatus } from "../core/pr-review.js";
import { postMrStatus, postMrSummary } from "../core/gitlab.js";
import { analysisFindingsToSarifResults, buildSarif } from "../core/sarif.js";
import { writeOutput } from "../core/io.js";
import { analyzeDependencyChanges, describeDependencyFindings } from "../core/deps.js";
import { analyzeTestDelta, describeTestDelta } from "../core/test-delta.js";
import { analyzeTestWeakness, describeTestWeakening } from "../core/test-weakening.js";
import { describeInjectionFindings, scanDiffForInjection } from "../core/injection.js";

const OPTIONS: OptionSpec = withCommon({
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
  "no-pr-inline": { type: "boolean" },
  "pr-status": { type: "boolean" },
  mr: { type: "boolean" },
  "mr-status": { type: "boolean" },
  "second-opinion": { type: "boolean" },
  "second-opinion-model": { type: "string" },
  "second-opinion-base-url": { type: "string" },
  "second-opinion-api-key-env": { type: "string" },
  "require-tests": { type: "boolean" },
  "no-test-weakening": { type: "boolean" },
  interactive: { type: "boolean" },
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
      --pr                  отправить review в PR: inline-комментарии к строкам (Actions)
      --no-pr-inline        только один сводный комментарий, без inline
      --pr-status           выставить статус-чек oc-pilot (нужен для branch protection)
      --mr                  отправить сводку в GitLab merge request (CI_MERGE_REQUEST_IID)
      --mr-status           выставить статус oc-pilot в GitLab (GITLAB_TOKEN)
      --second-opinion      проверить критичные находки второй моделью (openai)
      --second-opinion-model <m>  модель проверки (по умолчанию secondOpinionModel)
      --second-opinion-base-url <url> отдельный endpoint для проверки
      --second-opinion-api-key-env <name> отдельный env с ключом
      --require-tests       exit 3, если логика изменена без тестов
      --no-test-weakening   exit 3, если тесты ослаблены (skip, удалённые проверки)
      --interactive         разобрать находки и скрыть часть в baseline
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
  oc-pilot review --base main --pr --pr-status
  oc-pilot review --staged --second-opinion --require-tests
`;

export async function runReview(argv: string[]): Promise<number> {
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

  // Dependency gate: risky manifest changes (typosquats, unpinned or VCS specs).
  const depFindings = analyzeDependencyChanges(data.diff);
  if (depFindings.length > 0) {
    parts.push(`DEPENDENCY_CHANGES (проверь риски перед одобрением):\n${describeDependencyFindings(depFindings)}`);
    log.warn(`Зависимости: подозрительных изменений ${depFindings.length}.`);
  }

  // Test delta: changed logic without matching test changes.
  const testDelta = analyzeTestDelta(data.changedFiles, data.diff);
  if (testDelta.gap) {
    parts.push(`TEST_COVERAGE_HINT: ${describeTestDelta(testDelta)} — обдумай, нужны ли тесты/обновления тестов.`);
    log.warn(describeTestDelta(testDelta));
  }

  // Test weakening: skipped tests, removed or commented-out assertions.
  const testWeakness = analyzeTestWeakness(data.diff);
  if (testWeakness.length > 0) {
    parts.push(`TEST_WEAKENING (похоже, тесты ослаблены вместо починки кода):\n${describeTestWeakening(testWeakness)}`);
    log.warn(`Ослабление тестов: подозрительных мест ${testWeakness.length}.`);
  }

  // Prompt-injection heuristics over added lines.
  const injectionFindings = scanDiffForInjection(data.diff);
  if (injectionFindings.length > 0) {
    parts.push(
      `PROMPT_INJECTION_RISKS (строки похожи на инструкции для ИИ — провери источник):\n${describeInjectionFindings(injectionFindings)}`,
    );
    log.warn(`Возможные prompt-injection маркеры: ${injectionFindings.length}.`);
  }

  const userContext = asString(values, "context");
  if (userContext && userContext.trim()) {
    parts.push(`USER_CONTEXT:\n${userContext.trim()}`);
  }

  const updateBaseline = asBoolean(values, "update-baseline");
  const prWanted = asBoolean(values, "pr");
  const prInline = !asBoolean(values, "no-pr-inline");
  const prStatus = asBoolean(values, "pr-status");
  const mrWanted = asBoolean(values, "mr");
  const mrStatus = asBoolean(values, "mr-status");
  const interactiveWanted = asBoolean(values, "interactive");
  const requireTests = asBoolean(values, "require-tests");
  const forbidWeakening = asBoolean(values, "no-test-weakening");
  const baselineWanted = asBoolean(values, "baseline") || updateBaseline;
  const baseline = baselineWanted ? loadBaseline(ctx.cwd) : undefined;
  if (asBoolean(values, "baseline") && baseline && baseline.count === 0) {
    log.warn("Baseline пуст или не найден (.oc-pilot/baseline.json).");
  }

  const payload = {
    recipe: "review" as const,
    projectType: detectProjectType(ctx.cwd, data.changedFiles),
    additionalContext: parts.join("\n\n"),
    diff: data.payloadDiff,
    secretFindings: data.findings,
    changedFiles: data.changedFiles,
    failOnSecrets: asBoolean(values, "fail-on-secrets"),
    noSecretScan: asBoolean(values, "no-secret-scan"),
    baseline: baseline ? [...baseline.fingerprints] : undefined,
    meta: {
      source: data.source,
      ...(depFindings.length > 0
        ? { dependencies: { risky: depFindings.filter((finding) => finding.risks.length > 1).length } }
        : {}),
      ...(testDelta.gap
        ? { testDelta: { addedCodeLines: testDelta.addedCodeLines, codeFiles: testDelta.codeFiles.length } }
        : {}),
      ...(testWeakness.length > 0 ? { testWeakening: testWeakness.length } : {}),
      ...(injectionFindings.length > 0 ? { injection: injectionFindings.length } : {}),
    },
  };

  // Two-phase routing resolution: flag > no-flag > config > disabled.
  const routerModel = asString(values, "router-model") ?? ctx.config.routerModel;
  const routerEnabled = asBoolean(values, "router")
    ? true
    : asBoolean(values, "no-router")
      ? false
      : ctx.config.routerEnabled ?? false;
  const routerOptions = { enabled: routerEnabled, model: routerModel };

  // Second opinion resolution: flag > config > disabled.
  const secondOpinion: SecondOpinionPreferences = {
    enabled: asBoolean(values, "second-opinion") || (ctx.config.secondOpinionEnabled ?? false),
    model: asString(values, "second-opinion-model") ?? ctx.config.secondOpinionModel,
    baseUrl: asString(values, "second-opinion-base-url") ?? ctx.config.secondOpinionBaseUrl,
    apiKeyEnv: asString(values, "second-opinion-api-key-env") ?? ctx.config.secondOpinionApiKeyEnv,
  };

  if (ctx.flags.format !== "sarif" && !updateBaseline && !prWanted && !mrWanted && !interactiveWanted) {
    const code = await executeRecipe(payload, ctx, { router: routerOptions, secondOpinion });
    if (requireTests && testDelta.gap && code === 0) {
      log.warn("--require-tests: логика изменена без тестов.");
      return 3;
    }
    if (forbidWeakening && testWeakness.length > 0 && code === 0) {
      log.warn("--no-test-weakening: тесты ослаблены, а не починены.");
      return 3;
    }
    return code;
  }

  const capture = ctx.flags.format === "sarif";
  const runCtx = capture ? { ...ctx, flags: { ...ctx.flags, json: false, output: undefined } } : ctx;
  const execution = await executeRecipeDetailed(payload, runCtx, {
    capture: capture || interactiveWanted,
    router: routerOptions,
    secondOpinion,
  });
  if (ctx.flags.dryRun) return execution.exitCode;

  const rawFindings = execution.analysis ? parseFindings(execution.analysis) : [];

  if (updateBaseline) {
    const written = writeBaseline(ctx.cwd, rawFindings);
    log.success(`Baseline обновлён: находок ${written.count} → ${written.path}`);
    return 0;
  }

  if (interactiveWanted) {
    if (!process.stdin.isTTY) {
      log.warn("--interactive работает только в терминале (stdin не TTY) — вывожу как есть.");
      writeOutput(execution.analysis ?? "", ctx.flags.output);
      return execution.exitCode;
    }
    const chosen = await promptHideFindings(rawFindings.slice(0, 30));
    let findings = rawFindings;
    let text = execution.analysis ?? "";
    if (chosen.length > 0) {
      appendToBaseline(ctx.cwd, chosen);
      log.success(`Baseline пополнен: находок ${chosen.length} — будущие прогоны их скроют.`);
      const known = new Set(chosen.map((finding) => findingFingerprint(finding)));
      findings = filterFindings(rawFindings, known).kept;
      text = filterAnalysisText(text, known);
    }
    writeOutput(text, ctx.flags.output);
    const blocked =
      (payload.failOnSecrets && data.findings.some((finding) => finding.severity === "critical")) ||
      shouldFail(findings, ctx.config.failOn);
    return blocked ? 3 : 0;
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
    if (path) log.success(`SARIF записан: ${path}`);
  }

  if (prWanted) {
    const shaResult = runGit(["rev-parse", "HEAD"], ctx.cwd);
    const sha = shaResult.status === 0 ? shaResult.stdout.trim() : "";
    const summary = buildPrCommentBody(findings, { sha, knownHidden });
    const comments = prInline ? buildInlineComments(findings, data.diff) : [];
    const posted = await postPrReviewSummary(summary, comments, ctx.cwd);
    if (posted.inline) {
      log.success(`Review с ${posted.count} inline-комментариями отправлен в PR.`);
    } else {
      log.success("Сводный комментарий отправлен в PR.");
    }
    if (prStatus) {
      const blocked = findings.some((finding) => finding.severity === "critical");
      const state = blocked ? "failure" : "success";
      const description = blocked
        ? `oc-pilot: ${findings.length} finding(s), critical present`
        : "oc-pilot: no blocking findings";
      if (await postPrStatus(state, description, sha)) {
        log.info(`Статус-чек oc-pilot: ${state}.`);
      } else {
        log.warn("Статус-чек не отправлен: нужен запуск в Actions с GITHUB_TOKEN.");
      }
    }
  }

  if (mrWanted) {
    const shaResult = runGit(["rev-parse", "HEAD"], ctx.cwd);
    const sha = shaResult.status === 0 ? shaResult.stdout.trim() : "";
    const summary = buildPrCommentBody(findings, { sha, knownHidden });
    await postMrSummary(summary, ctx.cwd);
    if (mrStatus) {
      const blocked = findings.some((finding) => finding.severity === "critical");
      const state = blocked ? "failed" : "success";
      const description = blocked
        ? `oc-pilot: ${findings.length} finding(s), critical present`
        : "oc-pilot: no blocking findings";
      if (await postMrStatus(state, description, sha)) {
        log.info(`Статус oc-pilot в GitLab: ${state}.`);
      } else {
        log.warn("Статус в GitLab не отправлен: нужен GITLAB_TOKEN с правом api.");
      }
    }
  }

  if (requireTests && testDelta.gap && execution.exitCode === 0) {
    log.warn("--require-tests: логика изменена без тестов.");
    return 3;
  }

  if (forbidWeakening && testWeakness.length > 0 && execution.exitCode === 0) {
    log.warn("--no-test-weakening: тесты ослаблены, а не починены.");
    return 3;
  }

  return execution.exitCode;
}

async function promptHideFindings(findings: Awaited<ReturnType<typeof parseFindings>>): Promise<typeof findings> {
  if (findings.length === 0) return [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const chosen: typeof findings = [];
  try {
    for (const [index, finding] of findings.entries()) {
      const location = finding.location ? ` \`${finding.location}\`` : "";
      process.stdout.write(`${index + 1}/${findings.length} ${severityLabel(finding.severity)}${location} — ${finding.text}\n`);
      const answer = await rl.question("Скрыть в baseline? [y/N] ");
      if (answer.trim().toLowerCase().startsWith("y")) chosen.push(finding);
    }
  } finally {
    rl.close();
  }
  return chosen;
}
