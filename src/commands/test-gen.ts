import { existsSync } from "node:fs";
import { join } from "node:path";
import { runShellCommand } from "../core/command.js";
import { describeDiffSource, loadDiff } from "../core/diff-source.js";
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

const OPTIONS: OptionSpec = withCommon({
  apply: { type: "boolean" },
  "no-run": { type: "boolean" },
  "keep-failing": { type: "boolean" },
  force: { type: "boolean" },
  rounds: { type: "string" },
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
  oc-pilot test-gen --diff changes.diff --no-run`;

interface TestRun {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
}

/** Context lines that turn the generic custom recipe into a test generator. */
function baseContext(data: Awaited<ReturnType<typeof loadDiff>>, context: string | undefined): string[] {
  const parts = [
    "TEST_GEN_MODE: write tests that cover the behavior changed in GIT_DIFF.",
    "Return the normal output schema. Put exactly one ```diff fenced patch under `#### Solution`.",
    "The patch must only add or modify test files (*.test.ts, *.spec.ts, *_test.go, test_*.py). Do not change production code.",
    "Match the test framework and conventions already used in the repository; keep tests deterministic and offline.",
    `DIFF_SOURCE: ${describeDiffSource(data.source)}`,
    `DIFF_STATS: ${data.stats.files} файл(ов), +${data.stats.additions} / -${data.stats.deletions}`,
  ];
  if (data.untracked.length > 0) parts.push(`UNTRACKED_FILES: ${data.untracked.join(", ")}`);
  if (context?.trim()) parts.push(`USER_CONTEXT: ${context.trim()}`);
  return parts;
}

function describeStatus(status: string): string {
  if (status === "pass") return "тесты прошли";
  if (status === "fail") return "тесты упали";
  if (status === "not-run") return "тесты не запускались";
  return status;
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
  const rounds = parsePositiveInt(asString(values, "rounds") ?? "", "rounds", 5);
  const commandOverride = asString(values, "command");

  if (apply && !runTests && !asBoolean(values, "no-run")) {
    throw new PilotError("--apply требует запуска тестов", { hint: "Добавьте --no-run, если тесты запускать не нужно.", exitCode: 2 });
  }

  const data = await loadDiff(values, ctx, positionals, { optionalGit: true });
  if (data.changedFiles.length === 0) {
    log.info("Изменённых файлов нет — генерировать тесты не для чего.");
    return 0;
  }

  const testCommand = commandOverride ?? ctx.config.testCommand ?? detectTestCommand(ctx.cwd)?.command;
  if (runTests && !testCommand) {
    throw new PilotError("Не найдена команда тестов", {
      hint: "Укажите --command или поле testCommand в .oc-pilot.json.",
      exitCode: 2,
    });
  }

  const captureCtx = { ...ctx, flags: { ...ctx.flags, json: false, output: undefined } };
  const projectType = detectProjectType(ctx.cwd, data.changedFiles);
  const contextParts = baseContext(data, asString(values, "context"));

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
        diff: data.payloadDiff,
        secretFindings: data.findings,
        changedFiles: data.changedFiles,
        noSecretScan,
        meta: { source: data.source, testGenRound: round },
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
    meta: { source: data.source },
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
