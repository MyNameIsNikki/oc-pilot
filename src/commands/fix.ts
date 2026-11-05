import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean, asString, parsePositiveInt } from "../core/parse.js";
import { applyPatch, checkPatch, extractPatch, patchTargets, revertPatch } from "../core/patch.js";
import { runShellCommand } from "../core/command.js";
import { describeDiffSource, loadDiff } from "../core/diff-source.js";
import { detectProjectType, detectTestCommand } from "../core/project.js";
import { parseFindings } from "../core/findings.js";
import { scanSource, type SastFinding } from "../core/sast.js";
import { scanAuthzSource, type AuthzFinding } from "../core/authz.js";
import { PilotError } from "../core/errors.js";
import { isCodeFile, isGeneratedPath } from "../core/slop/source.js";
import { executeRecipeDetailed, githubAnnotations } from "../core/run.js";
import { loadSecretIgnore, scanDiff } from "../core/secrets.js";
import { createSnapshot, type SnapshotInfo } from "../core/snapshot.js";
import { isGitRepo } from "../core/git.js";

const OPTIONS: OptionSpec = withCommon({
  staged: { type: "boolean" },
  unstaged: { type: "boolean" },
  base: { type: "string" },
  diff: { type: "string" },
  stdin: { type: "boolean" },
  "include-untracked": { type: "boolean" },
  context: { type: "string" },
  command: { type: "string" },
  apply: { type: "boolean" },
  "no-tests": { type: "boolean" },
  "keep-on-test-failure": { type: "boolean" },
  "from-sast": { type: "boolean" },
  "from-authz": { type: "boolean" },
  rounds: { type: "string" },
  "no-secret-scan": { type: "boolean" },
  "no-snapshot": { type: "boolean" },
});

const HELP = `Использование:
  oc-pilot fix [пути...] [опции]

Просит модель предложить минимальный unified diff, проверяет его через
git apply --check и по желанию применяет. С --apply и тестами выполняет
цикл: применить → прогнать тесты → откатить при падении → попробовать снова.

Опции:
      --apply                применить патч к рабочему дереву
      --command <cmd>        команда тестов (по умолчанию автоопределение)
      --no-tests             не запускать тесты после применения
      --keep-on-test-failure оставить патч, даже если тесты упали
      --from-sast            исправить SAST-находки в изменённых файлах
      --from-authz           исправить находки авторизации маршрутов
      --rounds <n>           попыток исправления, 1..5 (по умолчанию 2)
      --staged               только staged-изменения
      --unstaged             только unstaged-изменения
      --base <ref>           diff <ref>...HEAD
      --diff <file|->        готовый diff
      --stdin                читать diff из stdin
      --include-untracked    включить новые файлы
      --context <text|@file> дополнительный контекст
      --no-secret-scan       не искать секреты в diff и патче
      --no-snapshot          не создавать снимок перед --apply
${COMMON_HELP}

Примеры:
  oc-pilot fix
  oc-pilot fix --apply
  oc-pilot fix --apply --command "npm test" --rounds 3
  oc-pilot fix --from-sast --staged --apply
  oc-pilot fix --from-authz --staged --apply
  oc-pilot fix src/wallet.go --apply
  oc-pilot restore            # откат к снимку последнего fix --apply
`;

interface FixTestResult {
  command: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  output: string;
}

function failureContext(patch: string, test: FixTestResult): string {
  return [
    "PREVIOUS_FIX_ATTEMPT failed.",
    "PATCH:",
    "```diff",
    patch,
    "```",
    `TEST_COMMAND: ${test.command}`,
    `TEST_EXIT_CODE: ${test.exitCode}`,
    "TEST_OUTPUT (tail):",
    test.output.slice(-20_000),
  ].join("\n");
}

export async function runFix(argv: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const ctx = resolveContext(values);
  const data = await loadDiff(values, ctx, positionals);
  if (!data.diff.trim()) {
    log.info("Изменений нет — исправлять нечего.");
    return 0;
  }

  const apply = asBoolean(values, "apply");
  const noTests = asBoolean(values, "no-tests");
  const roundsRaw = asString(values, "rounds");
  const rounds = roundsRaw ? parsePositiveInt(roundsRaw, "rounds", 5) : 2;
  const detectedTest = detectTestCommand(ctx.cwd);
  const testCommand = asString(values, "command") ?? detectedTest?.command;
  const userContext = asString(values, "context");
  const fromSast = asBoolean(values, "from-sast");
  const sastFiles = fromSast
    ? data.changedFiles.filter((file) => isCodeFile(file) && !isGeneratedPath(file) && existsSync(join(ctx.cwd, file)))
    : [];
  const sastBefore = fromSast
    ? sastFiles.flatMap((file) => scanSource(file, readFileSync(join(ctx.cwd, file), "utf8")).findings)
    : [];
  if (fromSast && sastBefore.length === 0) {
    log.info("SAST-находок нет — исправлять нечего.");
    return 0;
  }

  const fromAuthz = asBoolean(values, "from-authz");
  if (fromSast && fromAuthz) {
    throw new PilotError("--from-sast не сочетается с --from-authz", {
      hint: "Выберите один тип находок.",
      exitCode: 2,
    });
  }
  const authzFiles = fromAuthz
    ? data.changedFiles.filter((file) => isCodeFile(file) && !isGeneratedPath(file) && existsSync(join(ctx.cwd, file)))
    : [];
  const authzBefore = fromAuthz
    ? authzFiles.flatMap((file) => scanAuthzSource(file, readFileSync(join(ctx.cwd, file), "utf8")).findings)
    : [];
  if (fromAuthz && authzBefore.length === 0) {
    log.info("Находок авторизации нет — исправлять нечего.");
    return 0;
  }

  let snapshot: SnapshotInfo | undefined;
  if (apply && !ctx.flags.dryRun && !asBoolean(values, "no-snapshot")) {
    if (isGitRepo(ctx.cwd)) {
      snapshot = createSnapshot(ctx.cwd);
      log.success(
        `Снимок рабочего дерева создан: ${snapshot.id}` +
          `${snapshot.untrackedCount > 0 ? ` (untracked: ${snapshot.untrackedCount})` : ""}. Откат: oc-pilot restore ${snapshot.id}`,
      );
    } else {
      log.warn("Вне git-репозитория: снимок рабочего дерева не создан.");
    }
  }

  const baseParts = [
    "FIX_MODE: propose the smallest safe unified diff that fixes the most important problems in GIT_DIFF.",
    "Return the normal output schema. Put exactly one ```diff fenced patch under `#### Solution`.",
    "Only modify files that appear in GIT_DIFF. Do not add secrets, dependencies or generated files.",
    `DIFF_SOURCE: ${describeDiffSource(data.source)}`,
    `DIFF_STATS: ${data.stats.files} файл(ов), +${data.stats.additions} / -${data.stats.deletions}`,
  ];
  if (data.untracked.length > 0) {
    baseParts.push(`UNTRACKED_FILES (в diff):\n${data.untracked.map((file) => `- ${file}`).join("\n")}`);
  }
  if (userContext?.trim()) baseParts.push(`USER_CONTEXT:\n${userContext.trim()}`);
  if (fromSast) {
    baseParts[0] = "FIX_MODE: fix the SAST findings listed in SAST_FINDINGS. Propose the smallest safe unified diff.";
    baseParts.push(
      "Do not introduce new SAST findings. Keep the behavior unchanged and add no dependencies.",
      `SAST_FINDINGS:\n${sastBefore.map((finding) => `- ${finding.severity} ${finding.rule} ${finding.file}:${finding.line} — ${finding.message}`).join("\n")}`,
    );
  }

  if (fromAuthz) {
    baseParts[0] = "FIX_MODE: fix the authorization findings listed in AUTHZ_FINDINGS. Propose the smallest safe unified diff.";
    baseParts.push(
      "Do not introduce new authorization findings. Keep the behavior unchanged and add no dependencies.",
      `AUTHZ_FINDINGS:\n${authzBefore.map((finding) => `- ${finding.severity} ${finding.rule} ${finding.method} ${finding.route} ${finding.file}:${finding.line} — ${finding.message}`).join("\n")}`,
    );
  }

  const rescanSast = (): SastFinding[] =>
    sastFiles.flatMap((file) => scanSource(file, readFileSync(join(ctx.cwd, file), "utf8")).findings);
  const rescanAuthz = (): AuthzFinding[] =>
    authzFiles.flatMap((file) => scanAuthzSource(file, readFileSync(join(ctx.cwd, file), "utf8")).findings);

  const captureCtx = {
    ...ctx,
    flags: { ...ctx.flags, json: false, output: undefined },
  };

  let lastTest: FixTestResult | undefined;
  let lastPatch: string | undefined;
  let lastAnalysis: string | undefined;

  for (let round = 1; round <= rounds; round += 1) {
    const context = lastPatch && lastTest
      ? [...baseParts, `ROUND: ${round}`, failureContext(lastPatch, lastTest)].join("\n\n")
      : [...baseParts, `ROUND: ${round}`].join("\n\n");

    const execution = await executeRecipeDetailed(
      {
        recipe: "custom",
        projectType: detectProjectType(ctx.cwd, data.changedFiles),
        additionalContext: context,
        diff: data.payloadDiff,
        secretFindings: data.findings,
        changedFiles: data.changedFiles,
        noSecretScan: asBoolean(values, "no-secret-scan"),
        meta: { source: data.source, fixRound: round },
      },
      captureCtx,
      { capture: true, slicing: false },
    );

    if (ctx.flags.dryRun) return execution.exitCode;
    if (!execution.analysis) {
      log.warn("Модель не вернула анализ.");
      return 1;
    }
    lastAnalysis = execution.analysis;
    if (ctx.flags.github) {
      for (const annotation of githubAnnotations(parseFindings(execution.analysis), ctx.cwd)) {
        process.stderr.write(`${annotation}\n`);
      }
    }

    const patch = extractPatch(execution.analysis);
    if (!patch) {
      log.warn("В ответе нет unified diff. Нужен блок ```diff или diff --git.");
      return 1;
    }
    lastPatch = patch;

    const allowed = new Set(data.changedFiles);
    const outside = patchTargets(patch).filter((file) => !allowed.has(file));
    if (outside.length > 0) {
      log.warn(`Патч затрагивает файлы вне diff: ${outside.join(", ")}. Применение остановлено.`);
      return 1;
    }

    if (!asBoolean(values, "no-secret-scan")) {
      const secretScan = scanDiff(patch, { ignore: loadSecretIgnore(ctx.cwd) });
      if (secretScan.findings.some((finding) => finding.severity === "critical")) {
        log.warn("Патч содержит потенциальный секрет. Применение остановлено.");
        return 1;
      }
    }

    const check = await checkPatch(ctx.cwd, patch);
    if (check.exitCode !== 0) {
      log.warn(`Патч не применяется: ${check.stderr.trim() || check.stdout.trim() || "git apply --check failed"}`);
      if (!apply) return 1;
      lastTest = {
        command: "git apply --check",
        exitCode: check.exitCode,
        timedOut: false,
        durationMs: 0,
        output: check.stderr || check.stdout,
      };
      continue;
    }

    if (!apply) {
      if (ctx.flags.json) {
        const payload = {
          applied: false,
          patch,
          check: "ok",
          analysis: execution.analysis,
          meta: execution.meta,
        };
        const path = writeOutput(JSON.stringify(payload, null, 2), ctx.flags.output);
        if (path) log.success(`Результат записан: ${path}`);
      } else {
        process.stdout.write(`${execution.analysis.trim()}\n\n### Patch (not applied)\n\n\`\`\`diff\n${patch}\n\`\`\`\n`);
      }
      return 0;
    }

    const applied = await applyPatch(ctx.cwd, patch);
    if (applied.exitCode !== 0) {
      log.warn(`Не удалось применить патч: ${applied.stderr.trim() || applied.stdout.trim()}`);
      return 1;
    }
    log.success(`Патч применён (раунд ${round}).`);

    if (noTests || !testCommand) {
      if (!noTests) log.warn("Команда тестов не найдена; патч оставлен без проверки.");
      const sastAfter = fromSast ? rescanSast() : [];
      const sastRemaining = sastAfter.filter((finding) => finding.severity === "high");
      const sastInfo = fromSast
        ? { before: sastBefore.length, after: sastAfter.length, remaining: sastRemaining.length }
        : undefined;
      const authzAfter = fromAuthz ? rescanAuthz() : [];
      const authzRemaining = authzAfter.filter((finding) => finding.severity === "high");
      const authzInfo = fromAuthz
        ? { before: authzBefore.length, after: authzAfter.length, remaining: authzRemaining.length }
        : undefined;
      const payload = {
        applied: true,
        patch,
        tests: null,
        analysis: execution.analysis,
        meta: execution.meta,
        ...(sastInfo ? { sast: sastInfo } : {}),
        ...(authzInfo ? { authz: authzInfo } : {}),
      };
      if (ctx.flags.json) {
        const path = writeOutput(JSON.stringify(payload, null, 2), ctx.flags.output);
        if (path) log.success(`Результат записан: ${path}`);
      } else {
        process.stdout.write(`${execution.analysis.trim()}\n\n### Patch (applied)\n\n\`\`\`diff\n${patch}\n\`\`\`\n`);
      }
      if (sastRemaining.length > 0) {
        log.warn(`SAST: осталось ${String(sastRemaining.length)} high-находок.`);
        return 1;
      }
      if (authzRemaining.length > 0) {
        log.warn(`Authz: осталось ${String(authzRemaining.length)} high-находок.`);
        return 1;
      }
      return 0;
    }

    log.step(`Тесты: ${testCommand}`);
    const test = await runShellCommand(testCommand, ctx.cwd, {
      timeoutMs: ctx.config.timeoutSeconds * 1000,
      verbose: ctx.flags.verbose,
    });
    lastTest = { command: testCommand, ...test };

    if (test.exitCode === 0 && !test.timedOut) {
      log.success(`Тесты прошли (${Math.round(test.durationMs / 1000)} с). Патч оставлен.`);
      const sastAfter = fromSast ? rescanSast() : [];
      const sastRemaining = sastAfter.filter((finding) => finding.severity === "high");
      const sastInfo = fromSast
        ? { before: sastBefore.length, after: sastAfter.length, remaining: sastRemaining.length }
        : undefined;
      const authzAfter = fromAuthz ? rescanAuthz() : [];
      const authzRemaining = authzAfter.filter((finding) => finding.severity === "high");
      const authzInfo = fromAuthz
        ? { before: authzBefore.length, after: authzAfter.length, remaining: authzRemaining.length }
        : undefined;
      const payload = {
        applied: true,
        patch,
        tests: lastTest,
        analysis: execution.analysis,
        meta: execution.meta,
        ...(sastInfo ? { sast: sastInfo } : {}),
        ...(authzInfo ? { authz: authzInfo } : {}),
      };
      if (ctx.flags.json) {
        const path = writeOutput(JSON.stringify(payload, null, 2), ctx.flags.output);
        if (path) log.success(`Результат записан: ${path}`);
      } else {
        process.stdout.write(`${execution.analysis.trim()}\n\n### Patch (applied, tests passed)\n\n\`\`\`diff\n${patch}\n\`\`\`\n`);
      }
      if (sastRemaining.length > 0) {
        log.warn(`SAST: осталось ${String(sastRemaining.length)} high-находок.`);
        return 1;
      }
      if (authzRemaining.length > 0) {
        log.warn(`Authz: осталось ${String(authzRemaining.length)} high-находок.`);
        return 1;
      }
      return 0;
    }

    if (asBoolean(values, "keep-on-test-failure")) {
      log.warn(`Тесты упали (exit ${test.exitCode}${test.timedOut ? ", timeout" : ""}). Патч оставлен (--keep-on-test-failure).`);
      const payload = {
        applied: true,
        patch,
        tests: lastTest,
        analysis: execution.analysis,
        meta: execution.meta,
        error: "tests failed; patch kept by request",
      };
      if (ctx.flags.json) {
        const path = writeOutput(JSON.stringify(payload, null, 2), ctx.flags.output);
        if (path) log.success(`Результат записан: ${path}`);
      } else {
        process.stdout.write(`${execution.analysis.trim()}\n\n### Patch (applied, tests failed, kept)\n\n\`\`\`diff\n${patch}\n\`\`\`\n`);
      }
      return 1;
    }

    log.warn(`Тесты упали (exit ${test.exitCode}${test.timedOut ? ", timeout" : ""}). Откатываю патч.`);
    const reverted = await revertPatch(ctx.cwd, patch);
    if (reverted.exitCode !== 0) {
      log.error(`Не удалось откатить патч: ${reverted.stderr.trim() || reverted.stdout.trim()}`);
      return 1;
    }
    if (round === rounds) break;
    log.step(`Повторная попытка ${round + 1}/${rounds} с выводом тестов.`);
  }

  if (ctx.flags.json) {
    const payload = {
      applied: false,
      patch: lastPatch ?? null,
      tests: lastTest ?? null,
      analysis: lastAnalysis ?? null,
      error: "fix attempts exhausted; working tree restored",
    };
    const path = writeOutput(JSON.stringify(payload, null, 2), ctx.flags.output);
    if (path) log.success(`Результат записан: ${path}`);
  } else {
    log.error(`Не удалось получить зелёные тесты за ${rounds} попыт(и). Рабочее дерево восстановлено.`);
  }
  return 1;
}
