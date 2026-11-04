import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { runShellCommand } from "../core/command.js";
import { collectDiffStats } from "../core/diff.js";
import {
  changedLines,
  coverageGaps,
  describeCoverage,
  formatCoverageGaps,
  loadCoverage,
  type CoverageSummary,
} from "../core/coverage.js";
import { describeDiffSource, loadDiff, type DiffData } from "../core/diff-source.js";
import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean, asString, parsePositiveInt } from "../core/parse.js";
import { applyPatch, checkPatch, extractPatch, patchTargets, revertPatch } from "../core/patch.js";
import { detectProjectType, detectTestCommand } from "../core/project.js";
import { executeRecipeDetailed } from "../core/run.js";
import { loadSecretIgnore, scanDiff } from "../core/secrets.js";
import { isTestFile } from "../core/slop/source.js";
import {
  describeTarget,
  formatTestTargets,
  selectTestTargets,
  type TestTarget,
  type TestTargetSelection,
} from "../core/slop/test-debt.js";
import type { DiffStats } from "../types.js";

const OPTIONS: OptionSpec = withCommon({
  apply: { type: "boolean" },
  "no-run": { type: "boolean" },
  "keep-failing": { type: "boolean" },
  force: { type: "boolean" },
  rounds: { type: "string" },
  coverage: { type: "boolean" },
  "coverage-file": { type: "string" },
  "from-slop": { type: "boolean" },
  "slop-files": { type: "string" },
  command: { type: "string" },
  diff: { type: "string" },
  staged: { type: "boolean" },
  unstaged: { type: "boolean" },
  base: { type: "string" },
  "include-untracked": { type: "boolean" },
  context: { type: "string" },
  "no-secret-scan": { type: "boolean" },
});

const HELP = `Использование:
  oc-pilot test-gen [пути] [опции]

Просит модель написать тесты на изменённый код, применяет патч, запускает
тесты и оставляет только зелёные. Красные тесты откатываются, если не указан
--keep-failing. Без --apply команда только показывает патч.

Опции:
      --apply           применить патч и запустить тесты
      --no-run          применить патч, но не запускать тесты
      --keep-failing    оставить падающие тесты в рабочем дереве
      --force           разрешить менять существующие тестовые файлы
      --rounds <n>      сколько раз пробовать починить падающий тест (по умолчанию 2)
      --coverage        писать тесты только на непокрытые изменённые строки
      --coverage-file <path>  отчёт покрытия (lcov, istanbul, cobertura, Go coverprofile)
      --from-slop       выбрать цели сканом slop (файлы без тестов), а не из diff
      --slop-files <n>  сколько файлов выбирать в --from-slop (по умолчанию 3)
      --command <cmd>   команда тестов (иначе testCommand или автоопределение)
      --diff <file>     готовый unified diff вместо git-состояния
      --staged          взять staged-изменения
      --unstaged        взять unstaged-изменения
      --base <ref>      дифф <ref>...HEAD
      --include-untracked  включить неотслеживаемые файлы
      --context <text>  дополнительный контекст для модели
      --no-secret-scan  не сканировать патч на секреты
${COMMON_HELP}

Примеры:
  oc-pilot test-gen --staged --apply
  oc-pilot test-gen src/billing.ts --apply --rounds 1
  oc-pilot test-gen --base main --json
  oc-pilot test-gen --diff changes.diff --no-run
  oc-pilot test-gen --staged --coverage --apply
  oc-pilot test-gen --from-slop --apply`;

interface TestRun {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
}

/** Context lines that turn the generic custom recipe into a test generator. */
function baseContext(
  input: { source: string; stats: DiffStats; untracked: string[] },
  context: string | undefined,
  coverageText?: string,
  slopText?: string,
): string[] {
  const parts = [
    slopText
      ? "TEST_GEN_MODE: the files in GIT_DIFF are untested source files selected by the slop scan (see TEST_DEBT_TARGETS). Write tests that cover their public behavior. Do not modify the files in GIT_DIFF."
      : coverageText
        ? "TEST_GEN_MODE: write tests for the uncovered changed lines listed in COVERAGE_GAPS. Lines that are already covered need no new test."
        : "TEST_GEN_MODE: write tests that cover the behavior changed in GIT_DIFF.",
    "Return the normal output schema. Put exactly one ```diff fenced patch under `#### Solution`.",
    "The patch must only add or modify test files (*.test.ts, *.spec.ts, *_test.go, test_*.py). Do not change production code.",
    "Match the test framework and conventions already used in the repository; keep tests deterministic and offline.",
    slopText
      ? "DIFF_SOURCE: скан slop (содержимое уже включено в GIT_DIFF)"
      : `DIFF_SOURCE: ${describeDiffSource(input.source)}`,
    `DIFF_STATS: ${input.stats.files} файл(ов), +${input.stats.additions} / -${input.stats.deletions}`,
  ];
  if (slopText) parts.push(slopText);
  if (coverageText) parts.push(coverageText);
  if (input.untracked.length > 0) parts.push(`UNTRACKED_FILES: ${input.untracked.join(", ")}`);
  if (context?.trim()) parts.push(`USER_CONTEXT: ${context.trim()}`);
  return parts;
}

function describeStatus(status: string): string {
  if (status === "pass") return "тесты прошли";
  if (status === "fail") return "тесты упали";
  if (status === "not-run") return "тесты не запускались";
  return status;
}

/** Compact coverage block for the JSON payload. */
function coveragePayload(summary: CoverageSummary, cwd: string) {
  return {
    report: relative(cwd, summary.report.path).replace(/\\/g, "/"),
    format: summary.report.format,
    uncoveredLines: summary.uncoveredLines,
    gaps: summary.gaps,
    missing: summary.missing,
  };
}

/** Compact slop-target block for the JSON payload. */
function targetPayload(targets: TestTarget[]) {
  return targets.map((target) => ({
    file: target.file,
    score: target.score,
    lines: target.lines,
    reasons: target.reasons,
    commits: target.commits ?? null,
    testCommits: target.testCommits ?? null,
    days: target.days ?? null,
    duplicateBlocks: target.duplicateBlocks ?? null,
    duplicateTokens: target.duplicateTokens ?? null,
    todos: target.todos ?? null,
  }));
}

export async function runTestGen(argv: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const ctx = resolveContext(values);
  const apply = asBoolean(values, "apply");
  const runTests = apply && !asBoolean(values, "no-run");
  const keepFailing = asBoolean(values, "keep-failing");
  const force = asBoolean(values, "force");
  const noSecretScan = asBoolean(values, "no-secret-scan");
  const roundsRaw = asString(values, "rounds");
  const rounds = roundsRaw ? parsePositiveInt(roundsRaw, "rounds", 5) : 2;
  const commandOverride = asString(values, "command");
  const fromSlop = asBoolean(values, "from-slop");
  const slopFilesRaw = asString(values, "slop-files");
  const slopFiles = slopFilesRaw ? parsePositiveInt(slopFilesRaw, "slop-files", 50) : 3;

  if (apply && !runTests && !asBoolean(values, "no-run")) {
    throw new PilotError("--apply требует запуска тестов", { hint: "Добавьте --no-run, если тесты запускать не нужно.", exitCode: 2 });
  }

  if (fromSlop) {
    const conflicts: string[] = [];
    if (asString(values, "diff") !== undefined) conflicts.push("--diff");
    if (asBoolean(values, "stdin")) conflicts.push("--stdin");
    for (const flag of ["staged", "unstaged", "base", "include-untracked"]) {
      if (asBoolean(values, flag)) conflicts.push(`--${flag}`);
    }
    if (asBoolean(values, "coverage") || asString(values, "coverage-file") !== undefined) conflicts.push("--coverage");
    if (positionals.length > 0) conflicts.push("пути");
    if (conflicts.length > 0) {
      throw new PilotError(`--from-slop не сочетается с: ${conflicts.join(", ")}`, {
        hint: "--from-slop сам выбирает файлы для тестов по скану slop.",
        exitCode: 2,
      });
    }
  }

  let data: DiffData | undefined;
  let selection: TestTargetSelection | undefined;

  if (fromSlop) {
    selection = selectTestTargets(ctx.cwd, { limit: slopFiles });
    if (selection.targets.length === 0) {
      log.success("Файлов без тестов не найдено — генерировать тесты не для чего.");
      if (ctx.flags.json) {
        writeOutput(
          JSON.stringify(
            {
              applied: false,
              patch: null,
              files: [],
              status: "not-run",
              tests: null,
              rounds: 0,
              analysis: null,
              meta: { source: "slop" },
              coverage: null,
              targets: [],
            },
            null,
            2,
          ),
          ctx.flags.output,
        );
      }
      return 0;
    }
    log.info(
      `Цели по slop (без тестов ${String(selection.untested)} из ${String(selection.filesScanned)} файлов): ` +
        `${selection.targets.map((target) => `${target.file} — ${describeTarget(target)}`).join("; ")}.`,
    );
  } else {
    data = await loadDiff(values, ctx, positionals, { optionalGit: true });
    if (data.changedFiles.length === 0) {
      log.info("Изменённых файлов нет — генерировать тесты не для чего.");
      return 0;
    }
  }

  const payloadDiff = data ? data.payloadDiff : selection!.payloadDiff;
  const changedFiles = data ? data.changedFiles : selection!.targets.map((target) => target.file);
  const source = data ? data.source : "slop";
  const stats: DiffStats = data ? data.stats : collectDiffStats(payloadDiff);

  const testCommand = commandOverride ?? ctx.config.testCommand ?? detectTestCommand(ctx.cwd)?.command;
  if (runTests && !testCommand) {
    throw new PilotError("Не найдена команда тестов", {
      hint: "Укажите --command или поле testCommand в .oc-pilot.json.",
      exitCode: 2,
    });
  }

  const captureCtx = { ...ctx, flags: { ...ctx.flags, json: false, output: undefined } };
  const projectType = detectProjectType(ctx.cwd, changedFiles);

  const coverageRequested = asBoolean(values, "coverage") || Boolean(asString(values, "coverage-file"));
  let coverage: CoverageSummary | undefined;
  if (coverageRequested) {
    const report = loadCoverage(ctx.cwd, asString(values, "coverage-file"));
    if (!report) {
      throw new PilotError("Отчёт покрытия не найден", {
        hint: "Соберите покрытие или укажите файл: --coverage-file coverage/lcov.info.",
        exitCode: 2,
      });
    }
    coverage = coverageGaps(report, changedLines(payloadDiff));
    if (coverage.gaps.length === 0) {
      if (coverage.missing.length === 0) {
        log.success(`Все изменённые строки уже покрыты тестами (${describeCoverage(coverage)}).`);
        if (ctx.flags.json) {
          writeOutput(
            JSON.stringify(
              {
                applied: false,
                patch: null,
                files: [],
                status: "not-run",
                tests: null,
                rounds: 0,
                analysis: null,
                meta: { source },
                coverage: coveragePayload(coverage, ctx.cwd),
                targets: null,
              },
              null,
              2,
            ),
            ctx.flags.output,
          );
        }
        return 0;
      }
      log.warn(`Нет данных покрытия для: ${coverage.missing.join(", ")} — пишу тесты по всему диффу.`);
      coverage = undefined;
    } else {
      log.info(`Покрытие: ${describeCoverage(coverage)}.`);
    }
  }

  const contextParts = baseContext(
    { source, stats, untracked: data?.untracked ?? [] },
    asString(values, "context"),
    coverage ? formatCoverageGaps(coverage) : undefined,
    selection ? formatTestTargets(selection.targets) : undefined,
  );

  let patch: string | undefined;
  let analysis: string | undefined;
  let test: TestRun | null = null;
  let roundsUsed = 0;

  for (let round = 1; round <= rounds; round += 1) {
    roundsUsed = round;
    const execution = await executeRecipeDetailed(
      {
        recipe: "custom",
        projectType,
        additionalContext: contextParts.join("\n\n"),
        diff: payloadDiff,
        secretFindings: data?.findings ?? [],
        changedFiles,
        noSecretScan,
        meta: { source, testGenRound: round },
      },
      captureCtx,
      { capture: true, slicing: false },
    );

    analysis = execution.analysis;
    const candidate = extractPatch(execution.analysis ?? "");
    if (!candidate) {
      log.warn(`Раунд ${round}: модель не вернула diff-блок.`);
      contextParts.push("TEST_GEN_FEEDBACK: the previous reply had no ```diff block. Return exactly one patch under `#### Solution`.");
      continue;
    }

    const targets = patchTargets(candidate);
    if (targets.length === 0) {
      log.warn(`Раунд ${round}: в патче нет файлов.`);
      continue;
    }

    const foreign = targets.filter((file) => !isTestFile(file));
    if (foreign.length > 0) {
      log.warn(`Раунд ${round}: патч трогает не тестовые файлы (${foreign.join(", ")}) — отклоняю.`);
      contextParts.push(
        `TEST_GEN_FEEDBACK: the patch touched non-test files (${foreign.join(", ")}). Only test files are allowed.`,
      );
      continue;
    }

    if (!force) {
      const existing = targets.filter((file) => existsSync(join(ctx.cwd, file)));
      if (existing.length > 0) {
        log.warn(`Раунд ${round}: файлы уже существуют (${existing.join(", ")}) — нужен --force.`);
        contextParts.push(
          `TEST_GEN_FEEDBACK: these test files already exist (${existing.join(", ")}). Create new files instead or avoid rewriting them.`,
        );
        continue;
      }
    }

    const secretReport = scanDiff(candidate, { ignore: loadSecretIgnore(ctx.cwd) });
    if (secretReport.findings.some((finding) => finding.severity === "critical")) {
      throw new PilotError("В сгенерированных тестах найдены секреты", {
        hint: "Проверьте патч вручную: в тестовых данных не должно быть реальных ключей и токенов.",
        exitCode: 2,
      });
    }

    const check = await checkPatch(ctx.cwd, candidate);
    if (check.exitCode !== 0) {
      log.warn(`Раунд ${round}: патч не применяется — ${(check.stderr || check.stdout).trim().slice(0, 300)}`);
      contextParts.push(
        `TEST_GEN_FEEDBACK: the patch does not apply cleanly. Fix the context lines and try again.\n${(check.stderr || check.stdout).trim()}`,
      );
      continue;
    }

    patch = candidate;
    if (!apply) break;

    await applyPatch(ctx.cwd, candidate);
    if (!runTests) break;

    test = (await runShellCommand(testCommand!, ctx.cwd, {
      timeoutMs: ctx.config.timeoutSeconds * 1000,
      verbose: ctx.flags.verbose,
      maxBufferChars: Math.max(200_000, ctx.config.maxOutputChars * 5),
    })) as TestRun;

    if (test.exitCode === 0) break;

    if (keepFailing) break;

    await revertPatch(ctx.cwd, candidate);
    patch = undefined;
    contextParts.push(
      `TEST_GEN_FEEDBACK: the generated tests failed (exit ${String(test.exitCode)}). Produce a corrected patch.\n${test.output.slice(0, 4_000)}`,
    );
    if (round === rounds) break;
  }

  const status = patch ? (test ? (test.exitCode === 0 ? "pass" : "fail") : "not-run") : "fail";
  const files = patch ? patchTargets(patch) : [];
  const payload = {
    applied: apply && Boolean(patch),
    patch: patch ?? null,
    files,
    status,
    tests: test,
    rounds: roundsUsed,
    analysis: analysis ?? null,
    meta: { source },
    coverage: coverage ? coveragePayload(coverage, ctx.cwd) : null,
    targets: selection ? targetPayload(selection.targets) : null,
  };

  if (ctx.flags.json) {
    writeOutput(JSON.stringify(payload, null, 2), ctx.flags.output);
    return status === "fail" ? 1 : 0;
  }

  if (!patch) {
    log.warn("Тесты не сгенерированы: подходящего патча не нашлось.");
    return 1;
  }

  log.info(`Файлов в патче: ${files.length} (${files.join(", ")}).`);
  if (apply) {
    log.info(`Статус: ${describeStatus(status)}.`);
  }
  if (test && test.exitCode !== 0) {
    log.warn(`Команда тестов завершилась с кодом ${String(test.exitCode)}.`);
  }
  const text = apply ? `Статус: ${describeStatus(status)}.\n` : `${patch}\n`;
  if (ctx.flags.output) {
    const wrote = writeOutput(text, ctx.flags.output);
    if (wrote) log.success(`Отчёт сохранён: ${wrote}`);
  } else if (!apply) {
    process.stdout.write(text);
  }

  return status === "fail" ? 1 : 0;
}
