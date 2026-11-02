import { existsSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { PilotError } from "./errors.js";
import { parsePromptLang } from "./lang.js";
import { parseFailOn } from "./findings.js";
import { asBoolean, asString, parseSeconds, parseSize } from "./parse.js";
export const COMMON_OPTIONS = {
    cwd: { type: "string", short: "C" },
    model: { type: "string", short: "m" },
    agent: { type: "string" },
    config: { type: "string" },
    lang: { type: "string" },
    timeout: { type: "string" },
    "max-diff": { type: "string" },
    "max-file": { type: "string" },
    output: { type: "string", short: "o" },
    "no-repo-context": { type: "boolean" },
    "fail-on": { type: "string" },
    rules: { type: "string" },
    json: { type: "boolean" },
    "dry-run": { type: "boolean" },
    verbose: { type: "boolean" },
    strict: { type: "boolean" },
    github: { type: "boolean" },
    help: { type: "boolean", short: "h" },
};
export function withCommon(extra) {
    return { ...COMMON_OPTIONS, ...extra };
}
export function parseCommandArgs(args, options) {
    try {
        const parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
        return { values: parsed.values, positionals: parsed.positionals };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new PilotError(`Ошибка аргументов: ${message}`, {
            hint: "Проверьте команду: oc-pilot <команда> --help",
            exitCode: 2,
        });
    }
}
export function resolveContext(values) {
    const rawCwd = asString(values, "cwd");
    const cwd = rawCwd ? resolve(process.cwd(), rawCwd) : process.cwd();
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
        throw new PilotError(`Директория не найдена: ${cwd}`, { exitCode: 2 });
    }
    const overrides = {};
    const model = asString(values, "model");
    const agent = asString(values, "agent");
    const maxDiff = asString(values, "max-diff");
    const maxFile = asString(values, "max-file");
    const timeout = asString(values, "timeout");
    const failOn = asString(values, "fail-on");
    const rules = asString(values, "rules");
    const lang = asString(values, "lang");
    if (model !== undefined)
        overrides.model = model;
    if (agent !== undefined)
        overrides.agent = agent;
    if (maxDiff !== undefined)
        overrides.maxDiffChars = parseSize(maxDiff, "max-diff");
    if (maxFile !== undefined)
        overrides.maxFileChars = parseSize(maxFile, "max-file");
    if (timeout !== undefined)
        overrides.timeoutSeconds = parseSeconds(timeout, "timeout");
    if (lang !== undefined)
        overrides.lang = parsePromptLang(lang);
    if (failOn !== undefined) {
        try {
            overrides.failOn = parseFailOn(failOn);
        }
        catch (error) {
            throw new PilotError("Некорректный --fail-on", {
                hint: error instanceof Error ? error.message : String(error),
                exitCode: 2,
            });
        }
    }
    if (asBoolean(values, "no-repo-context"))
        overrides.repoContext = false;
    if (rules !== undefined)
        overrides.rules = rules;
    const loaded = loadConfig({
        cwd,
        explicitPath: asString(values, "config"),
        overrides,
    });
    const outputRaw = asString(values, "output");
    return {
        cwd,
        config: loaded.config,
        configPath: loaded.path,
        flags: {
            cwd,
            json: asBoolean(values, "json"),
            dryRun: asBoolean(values, "dry-run"),
            verbose: asBoolean(values, "verbose"),
            strict: asBoolean(values, "strict"),
            github: asBoolean(values, "github"),
            output: outputRaw ? resolve(cwd, outputRaw) : undefined,
        },
    };
}
export const COMMON_HELP = `  -C, --cwd <dir>       Рабочая директория (по умолчанию текущая)
  -m, --model <id>      Модель OpenCode в формате provider/model
      --agent <name>    Агент OpenCode (по умолчанию oc-pilot: read-only контекст)
      --no-repo-context Запретить агенту читать файлы проекта (только diff)
      --lang <en|ru>    Язык ответа модели (по умолчанию en)
      --config <path>   Путь к .oc-pilot.json
      --rules <path>    Файл правил проекта (по умолчанию .oc-pilot/rules.md)
      --timeout <dur>   Таймаут запроса: секунды или 5m (по умолчанию 300)
      --max-diff <size> Лимит diff: 120k, 1m (по умолчанию 120000)
      --max-file <size> Лимит одного файла для docgen (по умолчанию 60000)
      --fail-on <level> Exit 3 при замечаниях: critical, warning, style, none
  -o, --output <path>   Записать результат в файл
      --json            Машиночитаемый JSON в stdout
      --dry-run         Показать промпт, не вызывать модель
      --strict          Код 3, если ответ не соответствует OUTPUT SCHEMA
      --github          Печатать GitHub Actions annotations для findings
      --verbose         Подробный вывод OpenCode
  -h, --help            Показать помощь`;
//# sourceMappingURL=options.js.map