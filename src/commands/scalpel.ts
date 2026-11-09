import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runShellCommand } from "../core/command.js";
import { describeDiffSource, loadDiff } from "../core/diff-source.js";
import { PilotError } from "../core/errors.js";
import { runGit } from "../core/git.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean, asString, parseSeconds } from "../core/parse.js";
import { detectProjectType } from "../core/project.js";
import { executeRecipeDetailed } from "../core/run.js";
import {
  buildScalpelPrompt,
  parseScalpelHypothesis,
  renderScalpel,
  verifyScalpel,
  type ScalpelReport,
} from "../core/scalpel.js";
import { writeShadowDiff } from "../core/shadow.js";

const OPTIONS: OptionSpec = withCommon({
  log: { type: "string" },
  error: { type: "string" },
  command: { type: "string" },
  context: { type: "string" },
  apply: { type: "boolean" },
  "test-command": { type: "string" },
  "test-timeout": { type: "string" },
  "no-test": { type: "boolean" },
  diff: { type: "string" },
  stdin: { type: "boolean" },
  staged: { type: "boolean" },
  unstaged: { type: "boolean" },
  base: { type: "string" },
  "include-untracked": { type: "boolean" },
});

const HELP = `Использование:
  oc-pilot scalpel --log failing.log [опции]
  oc-pilot scalpel --command "npm test" [опции]

Модель получает лог падения и текущий diff, предлагает минимальный патч,
oc-pilot применяет текущий diff и патч в shadow worktree и запускает тесты.
Blast radius показывает символы и ссылки, которые затронуты патчем.

Статусы:
  [SCALPEL FIXED]       патч применён, тесты проходят
  [SCALPEL REJECTED]    патч не чинит тесты
  [SCALPEL UNVERIFIED]  тесты не запускались
  [SCALPEL ERROR]       модель или git не справились

Опции:
      --log <file>          лог падающих тестов
      --error <text>        текст ошибки
      --command <cmd>       запустить команду и взять её вывод как лог
      --context <text>      дополнительный контекст
      --apply               применить доказанный патч к рабочему дереву
      --test-command <cmd>  команда тестов (по умолчанию определяется)
      --test-timeout <180s> таймаут тестов
      --no-test             не запускать тесты (статус unverified)
      --diff <file|->       готовый unified diff
      --stdin               читать diff из stdin
      --staged              только staged-изменения
      --unstaged            только unstaged-изменения
      --base <ref>          diff против ветки
      --include-untracked   добавить неотслеживаемые файлы
${COMMON_HELP}

Коды выхода:
  0  патч доказан и применён/показан
  1  патч не чинит тесты
  2  ошибка модели, git или unverified

Примеры:
  oc-pilot scalpel --log test-failure.log
  oc-pilot scalpel --command "npm test" --test-command "npm test"
  oc-pilot scalpel --log failure.log --apply --json`;

function readTextFile(cwd: string, path: string): string {
  try {
    return readFileSync(resolve(cwd, path), "utf8");
  } catch {
    throw new PilotError(`Не удалось прочитать ${path}`, {
      hint: "Проверьте путь к файлу.",
      exitCode: 2,
    });
  }
}

function errorReport(reason: string, summary: string): ScalpelReport {
  const report: ScalpelReport = {
    status: "error",
    reason,
    patch: "",
    files: [],
    tests: "skipped",
    summary,
    content: "",
  };
  report.content = renderScalpel(report);
  return report;
}

function applyToWorktree(cwd: string, patch: string): void {
  const temp = writeShadowDiff(patch);
  try {
    const check = runGit(["apply", "--check", temp.path], cwd);
    if (check.status !== 0) {
      throw new PilotError("Патч не применился к рабочему дереву", {
        hint: check.stderr.trim() || check.stdout.trim() || undefined,
        exitCode: 2,
      });
    }
    const applied = runGit(["apply", temp.path], cwd);
    if (applied.status !== 0) {
      throw new PilotError("Не удалось применить патч к рабочему дереву", {
        hint: applied.stderr.trim() || applied.stdout.trim() || undefined,
        exitCode: 2,
      });
    }
  } finally {
    temp.cleanup();
  }
}

export async function runScalpel(argv: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (positionals.length > 0) {
    throw new PilotError("scalpel не принимает позиционных аргументов", {
      hint: "Передайте лог через --log, --error или --command.",
      exitCode: 2,
    });
  }

  const ctx = resolveContext(values);
  const logFile = asString(values, "log");
  const errorText = asString(values, "error");
  const command = asString(values, "command");
  const sources = [logFile, errorText, command].filter((value): value is string => Boolean(value));
  if (sources.length === 0) {
    throw new PilotError("Нужен лог падения", {
      hint: "Используйте --log, --error или --command.",
      exitCode: 2,
    });
  }
  if (sources.length > 1) {
    throw new PilotError("Укажите только один источник падения", {
      hint: "Выберите --log, --error или --command.",
      exitCode: 2,
    });
  }

  let failure = "";
  if (logFile) failure = readTextFile(ctx.cwd, logFile).trim();
  else if (errorText) failure = errorText.trim();
  else if (command) {
    const run = await runShellCommand(command, ctx.cwd, { timeoutMs: 300_000, maxBufferChars: 1_000_000 });
    if (run.timedOut) {
      throw new PilotError("Команда не завершилась за 300 секунд", { exitCode: 2 });
    }
    if (run.exitCode === 0) {
      log.info("Команда проходит — чинить нечего.");
      return 0;
    }
    failure = run.output.trim();
  }
  if (!failure) {
    throw new PilotError("Лог падения пуст", { exitCode: 2 });
  }

  const data = await loadDiff(values, ctx, [], { optionalGit: true });
  const source = describeDiffSource(data.source);
  const result = await executeRecipeDetailed(
    {
      recipe: "custom",
      projectType: detectProjectType(ctx.cwd, data.changedFiles),
      additionalContext: buildScalpelPrompt(failure, data.diff, asString(values, "context")),
      diff: "",
      secretFindings: [],
      changedFiles: [],
      failOnSecrets: false,
      noSecretScan: true,
      meta: { source },
    },
    ctx,
  );
  const hypothesis = parseScalpelHypothesis(result.analysis ?? "");
  if (!hypothesis) {
    const report = errorReport("", "[SCALPEL ERROR]: модель не вернула JSON с патчем.");
    const wrote = ctx.flags.json
      ? writeOutput(JSON.stringify(report, null, 2), ctx.flags.output)
      : writeOutput(report.content, ctx.flags.output);
    if (wrote) log.success(`Результат сохранён: ${wrote}`);
    log.error(report.summary);
    return 2;
  }

  const timeoutRaw = asString(values, "test-timeout");
  const report = await verifyScalpel(ctx.cwd, data.diff, hypothesis, {
    testCommand: asString(values, "test-command"),
    timeoutMs: timeoutRaw ? parseSeconds(timeoutRaw, "test-timeout") * 1000 : undefined,
    runTests: !asBoolean(values, "no-test"),
  });

  if (asBoolean(values, "apply") && report.status === "fixed") {
    applyToWorktree(ctx.cwd, report.patch);
    log.success("Патч применён к рабочему дереву.");
  }

  const wrote = ctx.flags.json
    ? writeOutput(JSON.stringify(report, null, 2), ctx.flags.output)
    : writeOutput(report.content, ctx.flags.output);
  if (wrote) log.success(`Результат сохранён: ${wrote}`);

  if (report.status === "fixed") {
    log.success(report.summary);
    return 0;
  }
  if (report.status === "rejected") {
    log.error(report.summary);
    return 1;
  }
  log.error(report.summary);
  return 2;
}
