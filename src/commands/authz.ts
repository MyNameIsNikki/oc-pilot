import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  authzSarif,
  buildAuthzReport,
  parseAuthzSeverity,
  renderAuthz,
  scanAuthzSource,
  severityAtLeast,
  type AuthzSeverity,
} from "../core/authz.js";
import { loadDiff } from "../core/diff-source.js";
import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean, asString, type ArgsValues } from "../core/parse.js";
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
  public: { type: "string" },
  "no-suppressions": { type: "boolean" },
});

const HELP = `Использование:
  oc-pilot authz [пути] [опции]

Проверяет маршруты изменённых файлов на пропущенную авторизацию: маршруты
без проверки сессии, IDOR (объект ищется по id из запроса без проверки
владельца или тенанта) и административные маршруты без проверки роли.
Понимает Express/Fastify/Koa-подобные объявления и Next.js (app/**/route.ts,
pages/api/**). Модель не вызывается, сеть не используется.

Опции:
      --fail-on-issue <level>  код 1 при находке не ниже high|medium (по умолчанию high)
      --ignore <rules>         пропустить правила (через запятую)
      --public <prefixes>      публичные префиксы маршрутов (через запятую)
      --no-suppressions        не учитывать комментарии oc-pilot:authz-ignore
      --diff <file>            готовый unified diff вместо git-состояния
      --staged                 взять staged-изменения
      --unstaged               взять unstaged-изменения
      --base <ref>             дифф <ref>...HEAD
      --include-untracked      включить неотслеживаемые файлы
${COMMON_HELP}

Подавление:
  // oc-pilot:authz-ignore idor: доступ ограничен на уровне API-шлюза

Примеры:
  oc-pilot authz --staged
  oc-pilot authz --base main --fail-on-issue high
  oc-pilot authz src/routes.ts --json
  oc-pilot authz --staged --format sarif -o authz.sarif`;

function normalizePath(cwd: string, file: string): string {
  return relative(cwd, resolve(cwd, file)).replace(/\\/g, "/");
}

function listArg(values: ArgsValues, key: string): string[] {
  return (asString(values, key) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export async function runAuthz(argv: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const ctx = resolveContext(values);
  const gate = parseAuthzSeverity(asString(values, "fail-on-issue") ?? "high");
  if (!gate) {
    throw new PilotError(`Некорректный порог --fail-on-issue: ${String(asString(values, "fail-on-issue"))}`, {
      hint: "Допустимые значения: high, medium.",
      exitCode: 2,
    });
  }
  const ignore = new Set(listArg(values, "ignore"));
  const publicRoutes = listArg(values, "public");

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
    const empty = buildAuthzReport(0, []);
    if (ctx.flags.format === "sarif") writeOutput(authzSarif(empty), ctx.flags.output);
    else if (ctx.flags.json) writeOutput(`${JSON.stringify(empty, null, 2)}\n`, ctx.flags.output);
    else writeOutput(renderAuthz(empty), ctx.flags.output);
    return 0;
  }

  const results = files.map((file) =>
    scanAuthzSource(file, readFileSync(join(ctx.cwd, file), "utf8"), {
      suppressions: !asBoolean(values, "no-suppressions"),
      publicRoutes,
    }),
  );
  const report = buildAuthzReport(files.length, results);
  const findings = report.findings.filter((finding) => !ignore.has(finding.rule));
  const summary: Record<AuthzSeverity, number> = { high: 0, medium: 0 };
  for (const finding of findings) summary[finding.severity] += 1;
  const finalReport = { ...report, findings, summary };

  const failed = findings.some((finding) => severityAtLeast(finding.severity, gate));
  const text =
    ctx.flags.format === "sarif"
      ? authzSarif(finalReport)
      : ctx.flags.json
        ? `${JSON.stringify(finalReport, null, 2)}\n`
        : renderAuthz(finalReport);
  const wrote = writeOutput(text, ctx.flags.output);
  if (wrote) log.success(`Отчёт сохранён: ${wrote}`);

  if (ctx.flags.format !== "sarif" && !ctx.flags.json) {
    if (finalReport.suppressed > 0) log.detail(`Подавлено находок: ${String(finalReport.suppressed)}.`);
    if (failed) log.error(`Есть находки уровня ${gate} и выше.`);
  }

  return failed ? 1 : 0;
}
