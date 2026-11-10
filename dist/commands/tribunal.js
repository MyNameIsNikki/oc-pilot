import { describeDiffSource, loadDiff } from "../core/diff-source.js";
import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString, parsePositiveInt } from "../core/parse.js";
import { detectProjectType } from "../core/project.js";
import { executeRecipeDetailed } from "../core/run.js";
import { aggregateTribunal, buildTribunalPrompt, isTribunalLens, parseTribunalFindings, renderTribunal, } from "../core/tribunal.js";
const OPTIONS = withCommon({
    lenses: { type: "string" },
    "min-consensus": { type: "string" },
    "fail-on": { type: "string" },
    diff: { type: "string" },
    stdin: { type: "boolean" },
    staged: { type: "boolean" },
    unstaged: { type: "boolean" },
    base: { type: "string" },
    "include-untracked": { type: "boolean" },
});
const HELP = `Использование:
  oc-pilot tribunal [опции]

Собирает трёх модельных ревьюеров — security, correctness и
maintainability — и оставляет только находки, которые подтвердили
несколько членов. Находка одного члена остаётся split, а не вердиктом.
Модель обязательна; детерминированной проверки здесь нет.

Опции:
      --lenses <list>       security,correctness,maintainability (по умолчанию все)
      --min-consensus <2>   сколько членов должны подтвердить находку
      --fail-on <level>     consensus (по умолчанию), any или never
      --diff <file|->       готовый unified diff
      --stdin               читать diff из stdin
      --staged              только staged-изменения
      --unstaged            только unstaged-изменения
      --base <ref>          diff против ветки
      --include-untracked   добавить неотслеживаемые файлы
${COMMON_HELP}

Коды выхода:
  0  clean или split без --fail-on any
  1  [TRIBUNAL CONSENSUS] (или любая находка при --fail-on any)
  2  ошибка модели или входа

Примеры:
  oc-pilot tribunal --staged
  oc-pilot tribunal --base main --lenses security,correctness
  oc-pilot tribunal --staged --fail-on any --json`;
function parseLenses(raw) {
    if (raw === undefined || raw.trim() === "")
        return ["security", "correctness", "maintainability"];
    const lenses = [];
    for (const part of raw.split(",")) {
        const value = part.trim();
        if (!value)
            continue;
        if (!isTribunalLens(value)) {
            throw new PilotError(`Неизвестная линза: ${value}`, {
                hint: "Используйте security, correctness или maintainability.",
                exitCode: 2,
            });
        }
        if (!lenses.includes(value))
            lenses.push(value);
    }
    if (lenses.length === 0) {
        throw new PilotError("Нужна хотя бы одна линза", { exitCode: 2 });
    }
    return lenses;
}
function parseFailOn(raw) {
    if (raw === undefined || raw.trim() === "")
        return "consensus";
    if (raw === "consensus" || raw === "any" || raw === "never")
        return raw;
    throw new PilotError(`Неизвестный --fail-on: ${raw}`, {
        hint: "Используйте consensus, any или never.",
        exitCode: 2,
    });
}
export async function runTribunal(argv) {
    const { values, positionals } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(`${HELP}\n`);
        return 0;
    }
    if (positionals.length > 0) {
        throw new PilotError("tribunal не принимает позиционных аргументов", {
            hint: "Передайте diff через --diff, --stdin или git-флаги.",
            exitCode: 2,
        });
    }
    const ctx = resolveContext(values);
    const lenses = parseLenses(asString(values, "lenses"));
    const minRaw = asString(values, "min-consensus");
    const minConsensus = minRaw ? parsePositiveInt(minRaw, "min-consensus", lenses.length) : 2;
    const failOn = parseFailOn(asString(values, "fail-on"));
    const data = await loadDiff(values, ctx, [], { optionalGit: true });
    if (!data.diff.trim()) {
        log.info("Изменений нет — судить нечего.");
        return 0;
    }
    const findings = [];
    let parsedLenses = 0;
    for (const lens of lenses) {
        const result = await executeRecipeDetailed({
            recipe: "custom",
            projectType: detectProjectType(ctx.cwd, data.changedFiles),
            additionalContext: buildTribunalPrompt(lens, data.diff),
            diff: "",
            secretFindings: [],
            changedFiles: [],
            failOnSecrets: false,
            noSecretScan: true,
            meta: { source: describeDiffSource(data.source), lens },
        }, ctx);
        const parsed = parseTribunalFindings(result.analysis ?? "", lens);
        if (!parsed)
            continue;
        parsedLenses += 1;
        findings.push(...parsed);
    }
    if (parsedLenses === 0) {
        const report = {
            lenses,
            findings: [],
            verdicts: [],
            status: "error",
            summary: "[TRIBUNAL ERROR]: ни одна линза не вернула JSON с находками.",
            content: "",
        };
        report.content = renderTribunal(report);
        const wrote = ctx.flags.json
            ? writeOutput(JSON.stringify(report, null, 2), ctx.flags.output)
            : writeOutput(report.content, ctx.flags.output);
        if (wrote)
            log.success(`Результат сохранён: ${wrote}`);
        log.error(report.summary);
        return 2;
    }
    const report = aggregateTribunal(lenses, findings, minConsensus);
    const wrote = ctx.flags.json
        ? writeOutput(JSON.stringify(report, null, 2), ctx.flags.output)
        : writeOutput(report.content, ctx.flags.output);
    if (wrote)
        log.success(`Результат сохранён: ${wrote}`);
    if (report.status === "consensus") {
        log.error(report.summary);
        return failOn === "never" ? 0 : 1;
    }
    if (report.status === "split") {
        log.warn(report.summary);
        return failOn === "any" ? 1 : 0;
    }
    log.success(report.summary);
    return 0;
}
//# sourceMappingURL=tribunal.js.map