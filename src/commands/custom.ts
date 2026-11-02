import { describeDiffSource, loadDiff } from "../core/diff-source.js";
import { PilotError } from "../core/errors.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";
import { detectProjectType } from "../core/project.js";
import { executeRecipe } from "../core/run.js";

const OPTIONS: OptionSpec = withCommon({
  context: { type: "string" },
  diff: { type: "string" },
  stdin: { type: "boolean" },
  "git-diff": { type: "boolean" },
  staged: { type: "boolean" },
  base: { type: "string" },
  "include-untracked": { type: "boolean" },
  "no-secret-scan": { type: "boolean" },
  "fail-on-secrets": { type: "boolean" },
});

const HELP = `Использование:
  oc-pilot custom "<запрос>" [опции]

Свободный запрос к oc-pilot с необязательным diff и контекстом.

Опции:
      --context <text|@file> дополнительный контекст
      --diff <file|->        готовый diff
      --stdin                читать diff из stdin
      --git-diff             приложить git diff HEAD
      --staged               приложить только staged-изменения
      --base <ref>           приложить diff <ref>...HEAD
      --include-untracked    включить новые файлы
      --no-secret-scan       не искать секреты и не редактировать diff
      --fail-on-secrets      exit 3 при critical-секретах
${COMMON_HELP}

Примеры:
  oc-pilot custom "Предложи, как разбить этот модуль" --git-diff
  oc-pilot custom "Найди гонки данных" --diff changes.patch
  oc-pilot custom "Объясни архитектуру" --context @ARCHITECTURE.md
`;

export async function runCustom(argv: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const instruction = positionals.join(" ").trim();
  if (!instruction) {
    throw new PilotError("Не указан запрос", {
      hint: 'Пример: oc-pilot custom "Найди утечки памяти" --git-diff',
      exitCode: 2,
    });
  }

  const ctx = resolveContext(values);
  const diffFlag = asString(values, "diff");
  const stdinFlag = asBoolean(values, "stdin");
  const gitDiff = asBoolean(values, "git-diff");
  const gitFlags = asBoolean(values, "staged") || asBoolean(values, "include-untracked") || asString(values, "base") !== undefined;
  const explicitDiff = diffFlag !== undefined || stdinFlag;

  if (gitDiff && explicitDiff) {
    throw new PilotError("--git-diff нельзя комбинировать с --diff/--stdin", { exitCode: 2 });
  }

  const wantDiff = gitDiff || gitFlags || explicitDiff;
  const data = wantDiff ? await loadDiff(values, ctx) : undefined;

  const parts = [`USER_REQUEST:\n${instruction}`];
  const context = asString(values, "context");
  if (context && context.trim()) parts.push(`USER_CONTEXT:\n${context.trim()}`);
  if (data) {
    parts.push(`DIFF_SOURCE: ${describeDiffSource(data.source)}`);
    parts.push(`DIFF_STATS: ${data.stats.files} файл(ов), +${data.stats.additions} / -${data.stats.deletions}`);
    if (data.changedFiles.length > 0) {
      parts.push(`CHANGED_FILES:\n${data.changedFiles.map((file) => `- ${file}`).join("\n")}`);
    }
  }

  return executeRecipe(
    {
      recipe: "custom",
      projectType: detectProjectType(ctx.cwd, data?.changedFiles ?? []),
      additionalContext: parts.join("\n\n"),
      diff: data?.payloadDiff ?? "",
      secretFindings: data?.findings ?? [],
      changedFiles: data?.changedFiles ?? [],
      failOnSecrets: asBoolean(values, "fail-on-secrets"),
      noSecretScan: asBoolean(values, "no-secret-scan"),
      meta: { source: data?.source ?? "без diff" },
    },
    ctx,
  );
}
