import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { PilotError } from "../core/errors.js";
import { severityLabel } from "../core/findings.js";
import { writeOutput } from "../core/io.js";
import { loadLastReview, matchFindings, parseTarget } from "../core/last-review.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asString } from "../core/parse.js";
import { scanText } from "../core/secrets.js";
const OPTIONS = withCommon({});
const HELP = `oc-pilot explain — показать, что именно нашло последнее ревью

Использование:
  oc-pilot explain <файл:строка>   объяснить находки для места в коде
  oc-pilot explain                 перечислить все находки последнего ревью

Результат берётся из .git/oc-pilot/last-review.json: файл пишет команда
review при каждом прогоне и он не попадает в рабочее дерево.

Опции:
${COMMON_HELP}      -h, --help          Показать эту справку

Примеры:
  oc-pilot explain src/wallet.ts:42
  oc-pilot explain --json
`;
function readSnippet(cwd, file, line, radius = 2) {
    const root = resolve(cwd);
    const absolute = resolve(root, file);
    if (!absolute.startsWith(`${root}${sep}`) && absolute !== root)
        return [];
    if (!existsSync(absolute))
        return [];
    try {
        if (!statSync(absolute).isFile())
            return [];
        const lines = readFileSync(absolute, "utf8").split(/\r?\n/);
        const from = Math.max(1, line - radius);
        const to = Math.min(lines.length, line + radius);
        const out = [];
        for (let index = from; index <= to; index += 1) {
            const raw = lines[index - 1] ?? "";
            const redacted = scanText(raw, file).redacted;
            out.push(`${index === line ? ">" : " "} ${String(index).padStart(4, " ")} ${redacted}`);
        }
        return out;
    }
    catch {
        return [];
    }
}
function renderFinding(finding) {
    const where = finding.location ? ` ${finding.location}` : "";
    return `${severityLabel(finding.severity)}${where} — ${finding.text}`;
}
export async function runExplain(argv) {
    const { values, positionals } = parseCommandArgs(argv, OPTIONS);
    if (values.help) {
        process.stdout.write(HELP);
        return 0;
    }
    const ctx = resolveContext(values);
    const review = loadLastReview(ctx.cwd);
    if (!review) {
        log.error("Нет сохранённого ревью: сначала запустите oc-pilot review.");
        return 1;
    }
    if (positionals.length > 1) {
        throw new PilotError("explain принимает один аргумент вида файл:строка", { exitCode: 2 });
    }
    const targetValue = positionals[0] ?? asString(values, "target");
    const target = targetValue ? parseTarget(targetValue) : undefined;
    if (targetValue && !target) {
        throw new PilotError(`Не удалось разобрать «${targetValue}»`, {
            hint: "Ожидается путь и строка, например src/wallet.ts:42",
            exitCode: 2,
        });
    }
    const findings = target ? matchFindings(review.findings, target) : review.findings.slice(0, 20);
    if (ctx.flags.json) {
        const payload = {
            createdAt: review.createdAt,
            recipe: review.recipe,
            model: review.model ?? null,
            target: target ?? null,
            findings,
        };
        writeOutput(JSON.stringify(payload, null, 2), ctx.flags.output);
        return 0;
    }
    if (findings.length === 0) {
        const where = target ? ` для ${target.file}:${target.line}` : "";
        log.info(`Находок не найдено${where}. Последнее ревью: ${review.createdAt}.`);
        return 0;
    }
    const header = target
        ? `Находки для ${target.file}:${target.line}`
        : `Находки последнего ревью (${review.createdAt})`;
    const lines = [header, ""];
    for (const finding of findings)
        lines.push(`- ${renderFinding(finding)}`);
    if (target) {
        const snippet = readSnippet(ctx.cwd, target.file, target.line);
        if (snippet.length > 0) {
            lines.push("", "Код:", ...snippet);
        }
        else {
            lines.push("", "Файл не найден в рабочем дереве — показаны только находки.");
        }
    }
    writeOutput(lines.join("\n"), ctx.flags.output);
    return 0;
}
//# sourceMappingURL=explain.js.map