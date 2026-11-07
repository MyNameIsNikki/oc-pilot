import { existsSync, readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { buildBlindfoldPrompt, judgeBlindfold, obfuscateCode, parseBlindfoldVerdict, parseMinConfidence, renderBlindfold } from "../core/blindfold.js";
import { splitDiffBlocks } from "../core/diff.js";
import { loadDiff } from "../core/diff-source.js";
import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";
import { detectProjectType } from "../core/project.js";
import { executeRecipeDetailed } from "../core/run.js";
const OPTIONS = withCommon({
    file: { type: "string" },
    diff: { type: "string" },
    stdin: { type: "boolean" },
    staged: { type: "boolean" },
    unstaged: { type: "boolean" },
    base: { type: "string" },
    "include-untracked": { type: "boolean" },
    context: { type: "string" },
    "min-confidence": { type: "string" },
    "dry-run": { type: "boolean" },
});
const HELP = `Использование:
  oc-pilot blindfold [--file <path> | diff-флаги] [опции]

Обезличивает код перед отправкой модели: имена функций, переменных и
классов заменяются на fn_A, var_A и type_A, а строки, комментарии и
свойства после точки сохраняются. Модель должна восстановить логику по
потоку управления и данным, не опираясь на названия, и вернуть строгий
JSON-вердикт. Если логика непонятна, найдена уязвимость или уверенность
ниже порога — код отклоняется с [BLINDFOLD REJECTED].

Опции:
      --file <path>          проверить один файл вместо diff
      --diff <file|->        готовый unified diff
      --stdin                читать diff из stdin
      --staged               только staged-изменения
      --unstaged             только unstaged-изменения
      --base <ref>           diff против ветки
      --include-untracked    добавить неотслеживаемые файлы
      --context <text>       что делает код и что проверить
      --min-confidence <0-1> минимальная уверенность модели (по умолчанию 0.6)
      --dry-run              показать обезличенный код без вызова модели
      --json                 вернуть JSON с вердиктом и картой замен
${COMMON_HELP}

Примеры:
  oc-pilot blindfold --staged --context "платежный расчёт"
  oc-pilot blindfold --file src/wallet.ts --min-confidence 0.8
  oc-pilot blindfold --diff changes.diff --dry-run
  oc-pilot blindfold --file src/app.ts --json`;
const MAX_FILE_BYTES = 256_000;
function safeFile(cwd, file) {
    const root = resolve(cwd);
    const target = resolve(root, file);
    const rel = relative(root, target);
    if (!rel || rel.startsWith("..") || rel.includes(`..${sep}`) || resolve(root, rel) !== target) {
        throw new PilotError("Файл выходит за пределы проекта", { exitCode: 2 });
    }
    return target;
}
function addedCode(diff) {
    const parts = [];
    for (const block of splitDiffBlocks(diff)) {
        if (block.path === "(unknown)" || block.path === "(diff)")
            continue;
        const lines = [];
        let inHunk = false;
        for (const line of block.text.split(/\r?\n/)) {
            if (line.startsWith("@@")) {
                inHunk = true;
                continue;
            }
            if (!inHunk)
                continue;
            if (line.startsWith("+++") || line.startsWith("---"))
                continue;
            if (line.startsWith("+"))
                lines.push(line.slice(1));
        }
        if (lines.length > 0)
            parts.push(`// ${block.path}`, ...lines);
    }
    return parts.join("\n");
}
export async function runBlindfold(argv) {
    const { values, positionals } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(HELP);
        return 0;
    }
    if (positionals.length > 0) {
        throw new PilotError("blindfold не принимает позиционных аргументов", {
            hint: "Передайте файл через --file, а diff — через --diff или git-флаги.",
            exitCode: 2,
        });
    }
    const ctx = resolveContext(values);
    const file = asString(values, "file");
    const minConfidence = parseMinConfidence(asString(values, "min-confidence"));
    const dryRun = asBoolean(values, "dry-run");
    let source;
    let code;
    let changedFiles = [];
    if (file) {
        if (file.endsWith(".tsx")) {
            throw new PilotError("blindfold не поддерживает .tsx", {
                hint: "Передайте .ts, .js или .mjs файл.",
                exitCode: 2,
            });
        }
        const target = safeFile(ctx.cwd, file);
        if (!existsSync(target)) {
            throw new PilotError(`Файл не найден: ${file}`, { exitCode: 2 });
        }
        if (statSync(target).size > MAX_FILE_BYTES) {
            throw new PilotError(`Файл больше ${String(MAX_FILE_BYTES)} байт`, { exitCode: 2 });
        }
        source = `file:${file}`;
        code = readFileSync(target, "utf8");
        changedFiles = [file];
    }
    else {
        const data = await loadDiff(values, ctx, [], { optionalGit: true });
        if (!data.diff.trim()) {
            log.info("Изменений нет — обезличивать нечего.");
            return 0;
        }
        source = data.source;
        code = addedCode(data.diff);
        changedFiles = data.changedFiles;
        if (!code.trim()) {
            log.info("В diff нет добавленного кода — проверять нечего.");
            return 0;
        }
    }
    const obfuscation = obfuscateCode(code);
    if (dryRun) {
        const payload = {
            source,
            file,
            code: obfuscation.code,
            mapping: obfuscation.mapping,
        };
        if (ctx.flags.json) {
            const wrote = writeOutput(JSON.stringify(payload, null, 2), ctx.flags.output);
            if (wrote)
                log.success(`Результат сохранён: ${wrote}`);
        }
        else {
            const map = obfuscation.mapping.map((entry) => `${entry.original} -> ${entry.replacement}`).join("\n");
            const wrote = writeOutput(`${obfuscation.code}\n\n# mapping\n${map}\n`, ctx.flags.output);
            if (wrote)
                log.success(`Результат сохранён: ${wrote}`);
        }
        return 0;
    }
    const result = await executeRecipeDetailed({
        recipe: "custom",
        projectType: detectProjectType(ctx.cwd, changedFiles),
        additionalContext: buildBlindfoldPrompt(obfuscation.code, asString(values, "context")),
        diff: "",
        secretFindings: [],
        changedFiles: [],
        failOnSecrets: false,
        noSecretScan: true,
        meta: { source, file, hidden: obfuscation.mapping.length },
    }, ctx);
    const verdict = parseBlindfoldVerdict(result.analysis ?? "");
    const judged = judgeBlindfold(verdict, minConfidence);
    const report = {
        source,
        file,
        status: judged.status,
        summary: judged.summary,
        verdict,
        mapping: obfuscation.mapping,
    };
    if (ctx.flags.json) {
        const wrote = writeOutput(JSON.stringify(report, null, 2), ctx.flags.output);
        if (wrote)
            log.success(`Отчёт сохранён: ${wrote}`);
    }
    else {
        const wrote = writeOutput(renderBlindfold(report), ctx.flags.output);
        if (wrote)
            log.success(`Отчёт сохранён: ${wrote}`);
    }
    if (report.status === "pass")
        return 0;
    log.error(report.summary);
    return 1;
}
//# sourceMappingURL=blindfold.js.map