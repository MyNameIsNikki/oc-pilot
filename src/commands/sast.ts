import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { loadDiff } from "../core/diff-source.js";
import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";
import {
  buildSastReport,
  parseSastSeverity,
  renderSast,
  sastSarif,
  scanSource,
  severityAtLeast,
  type SastSeverity,
} from "../core/sast.js";
import { isCodeFile, isGeneratedPath } from "../core/slop/source.js";

const OPTIONS: OptionSpec = withCommon({
  diff: { type: "string" },
  stdin: { type: "boolean" },
  staged: { type: "boolean" },
  unstaged: { type: "boolean" },
  base: { type: "string" },
  "include-untracked": { type: "boolean" },
  "fail-on-issue": { type: "string" },
  ignore: { type: "string" },
  "no-suppressions": { type: "boolean" },
});

const HELP = `Использование:
  oc-pilot sast [пути] [опции]

Детерминированный статический анализ изменённых файлов: инъекции команд и SQL,
path traversal, SSRF, выполнение кода, XSS, открытые редиректы, отключённая
проверка TLS, wildcard CORS, prototype pollution, слабые хеши и JWT none.
Модель не вызывается, сеть не используется.

Опции:
      --fail-on-issue <level>  код 1 при находке не ниже high|medium|low (по умолчанию high)
      --ignore <rules>         пропустить правила (через запятую)
      --no-suppressions        не учитывать комментарии oc-pilot:sast-ignore
      --diff <file>            готовый unified diff вместо git-состояния
      --staged                 взять staged-изменения
      --unstaged               взять unstaged-изменения
      --base <ref>             дифф <ref>...HEAD
      --include-untracked      включить неотслеживаемые файлы
${COMMON_HELP}

Подавление:
  // oc-pilot:sast-ignore sql-injection: legacy query builder, вход проверен выше

Примеры:
  oc-pilot sast --staged
  oc-pilot sast --base main --fail-on-issue medium
  oc-pilot sast src/server.ts --json
  oc-pilot sast --staged --format sarif -o sast.sarif`;

function normalizePath(cwd: string, file: string): string {
  return relative(cwd, resolve(cwd, file)).replace(/\\/g, "/");
}

export async function runSast(argv: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const ctx = resolveContext(values);
  const gate = parseSastSeverity(asString(values, "fail-on-issue") ?? "high");
  if (!gate) {
    throw new PilotError(`Некорректный порог --fail-on-issue: ${String(asString(values, "fail-on-issue"))}`, {
      hint: "Допустимые значения: high, medium, low.",
      exitCode: 2,
    });
  }
  const ignore = new Set(
    (asString(values, "ignore") ?? "")
      .split(",")
      .map((rule) => rule.trim())
      .filter(Boolean),
  );

  let files: string[];
  if (positionals.length > 0) {
    files = positionals.map((file) => normalizePath(ctx.cwd, file));
    for (const file of files) {
      if (!existsSync(join(ctx.cwd, file))) {
        throw new PilotError(`Файл не найден: ${file}`, { exitCode: 2 });
      }
    }
  } else {
    const data = await loadDiff(values, ctx, [], { optionalGit: true });
    files = data.changedFiles.filter(
      (file) => isCodeFile(file) && !isGeneratedPath(file) && existsSync(join(ctx.cwd, file)),
    );
  }
  files = [...new Set(files)];

  if (files.length === 0) {
    log.info("Нет файлов для проверки.");
    const empty = buildSastReport(0, []);
    if (ctx.flags.format === "sarif") writeOutput(sastSarif(empty), ctx.flags.output);
    else if (ctx.flags.json) writeOutput(`${JSON.stringify(empty, null, 2)}\n`, ctx.flags.output);
    else writeOutput(renderSast(empty), ctx.flags.output);
    return 0;
  }

  const results = files.map((file) =>
    scanSource(file, readFileSync(join(ctx.cwd, file), "utf8"), {
      suppressions: !asBoolean(values, "no-suppressions"),
    }),
  );
  const report = buildSastReport(files.length, results);
  const findings = report.findings.filter((finding) => !ignore.has(finding.rule));
  const summary: Record<SastSeverity, number> = { high: 0, medium: 0, low: 0 };
  for (const finding of findings) summary[finding.severity] += 1;
  const finalReport = { ...report, findings, summary };

  const failed = findings.some((finding) => severityAtLeast(finding.severity, gate));
  const text =
    ctx.flags.format === "sarif"
      ? sastSarif(finalReport)
      : ctx.flags.json
        ? `${JSON.stringify(finalReport, null, 2)}\n`
        : renderSast(finalReport);
  const wrote = writeOutput(text, ctx.flags.output);
  if (wrote) log.success(`Отчёт сохранён: ${wrote}`);

  if (ctx.flags.format !== "sarif" && !ctx.flags.json) {
    if (finalReport.suppressed > 0) log.detail(`Подавлено находок: ${String(finalReport.suppressed)}.`);
    if (failed) log.error(`Есть находки уровня ${gate} и выше.`);
  }

  return failed ? 1 : 0;
}
