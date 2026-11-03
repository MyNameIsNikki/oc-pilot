import { readTextFile, writeOutput } from "../core/io.js";
import { PilotError } from "../core/errors.js";
import { describeFindings, shouldFail } from "../core/findings.js";
import { lastReviewPath, loadLastReview, type LastReview } from "../core/last-review.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean, asString, type ArgsValues } from "../core/parse.js";
import { buildPrCommentBody } from "../core/pr-comment.js";
import { analysisFindingsToSarifResults, buildSarif } from "../core/sarif.js";
import { runGit } from "../core/git.js";

const OPTIONS: OptionSpec = withCommon({
  in: { type: "string" },
  as: { type: "string" },
});

const HELP = `Использование:
  oc-pilot replay [опции]

Повторно выводит последнее сохранённое ревью без вызова модели:
текст, JSON, SARIF или markdown для PR. Полезно, чтобы перегенерировать
отчёт в другом формате или проверить интеграцию бесплатно.

Опции:
      --in <file>           взять ревью из файла, а не из .git/oc-pilot/last-review.json
      --as <name>           text (по умолчанию), json, sarif, md (--format понимает text/json/sarif)
  -o, --output <file>       записать результат в файл
      --fail-on <level>     вернуть код 3, если есть находки уровня critical|warning|style
${COMMON_HELP}

Примеры:
  oc-pilot replay
  oc-pilot replay --format sarif -o report.sarif
  oc-pilot replay --as md -o pr-comment.md
  oc-pilot replay --in review.json --fail-on critical
`;

type ReplayFormat = "text" | "json" | "sarif" | "md";

function parseFormat(values: ArgsValues): ReplayFormat {
  if (asBoolean(values, "json")) return "json";
  const raw = (asString(values, "as") ?? asString(values, "format") ?? "text").trim().toLowerCase();
  if (raw === "text" || raw === "json" || raw === "sarif") return raw;
  if (raw === "md" || raw === "markdown") return "md";
  throw new PilotError(`Неизвестный формат: ${raw}`, {
    hint: "Доступно: text, json, sarif, md (для markdown используйте --as md).",
    exitCode: 2,
  });
}

function readReviewFile(path: string): LastReview {
  const text = readTextFile(path, "файл ревью");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PilotError(`Не удалось разобрать JSON: ${path}`, { exitCode: 2 });
  }
  const review = parsed as Partial<LastReview>;
  if (!review || !Array.isArray(review.findings)) {
    throw new PilotError(`В файле нет поля findings: ${path}`, { exitCode: 2 });
  }
  return {
    version: typeof review.version === "number" ? review.version : 1,
    createdAt: typeof review.createdAt === "string" ? review.createdAt : "",
    recipe: typeof review.recipe === "string" ? review.recipe : "review",
    model: review.model,
    findings: review.findings,
  };
}

export function runReplay(argv: string[]): number {
  const { values } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const ctx = resolveContext(values);
  const format = parseFormat(values);
  const inputPath = asString(values, "in");

  const review = inputPath ? readReviewFile(inputPath) : loadLastReview(ctx.cwd);
  if (!review) {
    const stored = lastReviewPath(ctx.cwd);
    throw new PilotError("Сохранённого ревью нет", {
      hint: `Запустите oc-pilot review — результат сохраняется в ${stored ?? ".git/oc-pilot/last-review.json"}.`,
      exitCode: 2,
    });
  }

  const findings = review.findings;
  let text: string;
  if (format === "json") {
    text = `${JSON.stringify(review, null, 2)}\n`;
  } else if (format === "sarif") {
    text = `${JSON.stringify(buildSarif(analysisFindingsToSarifResults(findings, ctx.cwd)), null, 2)}\n`;
  } else if (format === "md") {
    const shaResult = runGit(["rev-parse", "HEAD"], ctx.cwd);
    const sha = shaResult.status === 0 ? shaResult.stdout.trim() : "";
    text = buildPrCommentBody(findings, { sha });
  } else {
    const header = [
      `Ревью: ${review.createdAt || "без даты"} · рецепт ${review.recipe}${review.model ? ` · модель ${review.model}` : ""}`,
      `Находок: ${findings.length}`,
      "",
    ].join("\n");
    text = `${header}${findings.length > 0 ? describeFindings(findings) : "Замечаний нет.\n"}`;
  }

  const wrote = writeOutput(text, ctx.flags.output);
  if (wrote) log.success(`Отчёт сохранён: ${wrote}`);

  return shouldFail(findings, ctx.config.failOn) ? 3 : 0;
}
