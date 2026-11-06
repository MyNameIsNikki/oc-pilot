import { describeDiffSource, loadDiff } from "../core/diff-source.js";
import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";
import { detectProjectType } from "../core/project.js";
import { buildRoastContext, parsePersona } from "../core/roast.js";
import { executeRecipeDetailed } from "../core/run.js";

const OPTIONS: OptionSpec = withCommon({
  persona: { type: "string" },
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
  oc-pilot roast [опции]

Прожарка diff: модель получает роль токсичного сеньора и высмеивает
сложность, нейминг, лишние абстракции и слепую веру в ИИ. Каждая шутка
опирается на конкретную строку, в конце — один короткий реальный фикс.
Код атакуется, автор — нет: без оскорблений личности и выдуманных строк.

Опции:
      --persona <name>    linus, ramsay, corporate или default (по умолчанию linus)
      --context <text>    что именно произошло и что стоит высмеять
      --diff <file|->     готовый unified diff
      --git-diff          взять git diff HEAD
      --staged            только staged-изменения
      --base <ref>        diff против ветки
      --include-untracked добавить неотслеживаемые файлы
      --json              вернуть JSON с полем roast
${COMMON_HELP}

Примеры:
  oc-pilot roast --staged
  oc-pilot roast --base main --persona ramsay
  oc-pilot roast --diff changes.diff --persona corporate --json`;

export async function runRoast(argv: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(HELP);
    return 0;
  }
  if (positionals.length > 0) {
    throw new PilotError("roast не принимает позиционных аргументов", {
      hint: "Передайте контекст через --context, а diff — через --diff или git-флаги.",
      exitCode: 2,
    });
  }

  const ctx = resolveContext(values);
  const persona = parsePersona(asString(values, "persona"));
  const diffFlag = asString(values, "diff");
  const stdinFlag = asBoolean(values, "stdin");
  const gitDiff = asBoolean(values, "git-diff");
  const gitFlags = asBoolean(values, "staged") || asBoolean(values, "include-untracked") || asString(values, "base") !== undefined;
  if (gitDiff && (diffFlag !== undefined || stdinFlag)) {
    throw new PilotError("--git-diff нельзя комбинировать с --diff или --stdin", { exitCode: 2 });
  }
  const wantDiff = gitDiff || gitFlags || diffFlag !== undefined || stdinFlag;
  const data = wantDiff ? await loadDiff(values, ctx) : undefined;
  if (data && !data.diff.trim()) {
    log.info("Изменений нет — прожаривать нечего.");
    return 0;
  }

  const parts = [buildRoastContext(persona, asString(values, "context"))];
  if (data) {
    parts.push(`DIFF_SOURCE: ${describeDiffSource(data.source)}`);
    parts.push(`DIFF_STATS: ${String(data.stats.files)} файл(ов), +${String(data.stats.additions)} / -${String(data.stats.deletions)}`);
    if (data.changedFiles.length > 0) parts.push(`CHANGED_FILES:\n${data.changedFiles.join("\n")}`);
  }

  const result = await executeRecipeDetailed(
    {
      recipe: "custom",
      projectType: detectProjectType(ctx.cwd, data?.changedFiles ?? []),
      additionalContext: parts.join("\n\n"),
      diff: data?.payloadDiff ?? "",
      secretFindings: data?.findings ?? [],
      changedFiles: data?.changedFiles ?? [],
      failOnSecrets: asBoolean(values, "fail-on-secrets"),
      noSecretScan: asBoolean(values, "no-secret-scan"),
      meta: { source: data?.source ?? "без diff", persona },
    },
    ctx,
  );

  const roast = (result.analysis ?? "").trim();
  if (ctx.flags.json) {
    const wrote = writeOutput(JSON.stringify({ persona, roast, meta: result.meta }, null, 2), ctx.flags.output);
    if (wrote) log.success(`Отчёт сохранён: ${wrote}`);
    return result.exitCode;
  }
  const wrote = writeOutput(`${roast}\n`, ctx.flags.output);
  if (wrote) log.success(`Отчёт сохранён: ${wrote}`);
  return result.exitCode;
}
