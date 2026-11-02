import { existsSync, globSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { truncateText } from "../core/diff.js";
import { PilotError } from "../core/errors.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";
import { detectProjectType } from "../core/project.js";
import { executeRecipe } from "../core/run.js";
import { scanText } from "../core/secrets.js";
const OPTIONS = withCommon({
    context: { type: "string" },
    symbol: { type: "string" },
    "no-secret-scan": { type: "boolean" },
    "fail-on-secrets": { type: "boolean" },
});
const HELP = `Использование:
  oc-pilot docgen <файлы или маски...> [опции]

Генерирует GoDoc/RustDoc/JSDoc/docstrings для выбранных файлов.

Опции:
      --symbol <name>        документировать только указанный символ
      --context <text|@file> дополнительный контекст
      --no-secret-scan       не искать секреты и не редактировать код
      --fail-on-secrets      exit 3 при critical-секретах
${COMMON_HELP}

Примеры:
  oc-pilot docgen src/core/prompt.ts
  oc-pilot docgen "src/**/*.ts" --symbol buildPrompt
  oc-pilot docgen internal/wallet --context "Стиль: GoDoc, без markdown"
`;
const SOURCE_EXTENSIONS = new Set([
    ".go",
    ".rs",
    ".py",
    ".pyi",
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".java",
    ".kt",
    ".kts",
    ".cs",
    ".c",
    ".h",
    ".cc",
    ".cpp",
    ".cxx",
    ".hpp",
    ".rb",
    ".php",
    ".swift",
    ".scala",
    ".sh",
    ".ps1",
    ".sql",
    ".lua",
    ".ex",
    ".exs",
    ".dart",
]);
const IGNORED_DIRS = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "target",
    "vendor",
    "coverage",
    ".next",
    "__pycache__",
    ".venv",
    "venv",
]);
function isSourceFile(file) {
    const match = /(\.[A-Za-z0-9]+)$/.exec(file);
    return match ? SOURCE_EXTENSIONS.has(match[1].toLowerCase()) : false;
}
function isIgnored(absolute, cwd) {
    const rel = relative(cwd, absolute);
    return rel.split(sep).some((segment) => IGNORED_DIRS.has(segment));
}
function walkDirectory(directory, cwd, output, depth = 0) {
    if (depth > 20)
        return;
    let entries;
    try {
        entries = readdirSync(directory, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        const absolute = resolve(directory, entry.name);
        if (entry.isDirectory()) {
            if (!IGNORED_DIRS.has(entry.name))
                walkDirectory(absolute, cwd, output, depth + 1);
        }
        else if (entry.isFile() && isSourceFile(entry.name) && !isIgnored(absolute, cwd)) {
            output.add(absolute);
        }
    }
}
function expandFiles(patterns, cwd) {
    const files = new Set();
    for (const pattern of patterns) {
        const hasMagic = /[*?[\]]/.test(pattern);
        if (hasMagic) {
            let matches;
            try {
                matches = isAbsolute(pattern)
                    ? globSync(pattern.replace(/\\/g, "/"))
                    : globSync(pattern.replace(/\\/g, "/"), { cwd });
            }
            catch (error) {
                throw new PilotError(`Некорректная маска: ${pattern}`, {
                    hint: error instanceof Error ? error.message : String(error),
                    exitCode: 2,
                });
            }
            if (matches.length === 0)
                throw new PilotError(`По маске ничего не найдено: ${pattern}`, { exitCode: 2 });
            for (const match of matches) {
                const absolute = isAbsolute(match) ? resolve(match) : resolve(cwd, match);
                if (!isIgnored(absolute, cwd) && isSourceFile(absolute))
                    files.add(absolute);
            }
            continue;
        }
        const absolute = resolve(cwd, pattern);
        if (!existsSync(absolute))
            throw new PilotError(`Файл или директория не найдены: ${pattern}`, { exitCode: 2 });
        const stats = statSync(absolute);
        if (stats.isDirectory())
            walkDirectory(absolute, cwd, files);
        else if (stats.isFile())
            files.add(absolute);
    }
    return [...files].sort();
}
export async function runDocgen(argv) {
    const { values, positionals } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(HELP);
        return 0;
    }
    if (positionals.length === 0) {
        throw new PilotError("Укажите файл, директорию или маску", {
            hint: "Пример: oc-pilot docgen src/core/prompt.ts",
            exitCode: 2,
        });
    }
    const ctx = resolveContext(values);
    const scanDisabled = asBoolean(values, "no-secret-scan");
    if (scanDisabled)
        log.warn("Сканирование секретов отключено (--no-secret-scan).");
    let files = expandFiles(positionals, ctx.cwd);
    if (files.length === 0) {
        throw new PilotError("Среди выбранных файлов нет исходников", {
            hint: "Поддерживаются Go, Rust, Python, TypeScript, JavaScript, Java, Kotlin, C#, C/C++, Ruby, PHP, Swift и др.",
            exitCode: 2,
        });
    }
    if (files.length > 60) {
        log.warn(`Выбрано ${files.length} файлов; обработаны первые 60.`);
        files = files.slice(0, 60);
    }
    const prepared = [];
    const findings = [];
    const relativePaths = [];
    for (const absolute of files) {
        let content;
        try {
            if (statSync(absolute).size > 2 * 1024 * 1024) {
                log.warn(`Пропущен большой файл (>2 МБ): ${relative(ctx.cwd, absolute)}`);
                continue;
            }
            content = readFileSync(absolute, "utf8");
        }
        catch (error) {
            log.warn(`Не удалось прочитать ${absolute}: ${error instanceof Error ? error.message : String(error)}`);
            continue;
        }
        if (content.includes("\0")) {
            log.warn(`Пропущен бинарный файл: ${relative(ctx.cwd, absolute)}`);
            continue;
        }
        const display = relative(ctx.cwd, absolute).replace(/\\/g, "/");
        const scan = scanDisabled ? { findings: [], redacted: content } : scanText(content, display);
        findings.push(...scan.findings);
        let body = ctx.config.redactSecrets ? scan.redacted : content;
        if (body.length > ctx.config.maxFileChars) {
            body = truncateText(body, ctx.config.maxFileChars, { mode: "head" }).text;
            log.warn(`Файл обрезан до ${ctx.config.maxFileChars} символов: ${display}`);
        }
        prepared.push({ path: display, content: body });
        relativePaths.push(display);
    }
    if (prepared.length === 0) {
        throw new PilotError("Не удалось прочитать ни одного файла", { exitCode: 1 });
    }
    const headerLength = prepared.reduce((sum, file) => sum + file.path.length + 16, 0);
    const totalBudget = Math.max(10_000, ctx.config.maxDiffChars - headerLength - 500);
    const perFile = Math.max(2_000, Math.floor(totalBudget / prepared.length));
    const fileBlocks = [];
    const included = [];
    let used = 0;
    for (const file of prepared) {
        let body = file.content;
        if (body.length > perFile) {
            body = truncateText(body, perFile, { mode: "head" }).text;
        }
        const block = `--- FILE: ${file.path} ---\n${body}`;
        if (used + block.length > totalBudget && included.length > 0)
            continue;
        fileBlocks.push(block);
        included.push(file.path);
        used += block.length;
    }
    if (included.length < prepared.length) {
        const omitted = prepared
            .map((file) => file.path)
            .filter((path) => !included.includes(path));
        log.warn(`В контекст не поместились файлы: ${omitted.join(", ")}`);
    }
    const parts = [
        "USER_REQUEST: Сгенерируй документацию для указанных файлов, не меняя логику кода.",
        `FILES_COUNT: ${included.length}`,
    ];
    const symbol = asString(values, "symbol");
    if (symbol)
        parts.push(`SYMBOL: ${symbol} (документируй только этот символ)`);
    const userContext = asString(values, "context");
    if (userContext && userContext.trim())
        parts.push(`USER_CONTEXT:\n${userContext.trim()}`);
    parts.push("FILES:", fileBlocks.join("\n\n"));
    return executeRecipe({
        recipe: "docgen",
        projectType: detectProjectType(ctx.cwd, relativePaths),
        additionalContext: parts.join("\n\n"),
        diff: "",
        secretFindings: findings,
        changedFiles: relativePaths,
        failOnSecrets: asBoolean(values, "fail-on-secrets"),
        noSecretScan: scanDisabled,
        meta: { files: relativePaths, symbol: symbol ?? null },
    }, ctx);
}
//# sourceMappingURL=docgen.js.map