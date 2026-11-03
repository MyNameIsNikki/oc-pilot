import { existsSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import type { CommandContext, ConfigOverrides, OutputFormat } from "../types.js";
import { loadConfig } from "./config.js";
import { parseBaseUrl, parseEngine, parseEnginePreset } from "./engine.js";
import { PilotError } from "./errors.js";
import { parsePromptLang } from "./lang.js";
import { parseFailOn } from "./findings.js";
import { asBoolean, asString, parseSeconds, parseSize, type ArgsValues } from "./parse.js";

export type OptionSpec = Record<string, { type: "string" | "boolean"; short?: string; multiple?: boolean }>;

export const COMMON_OPTIONS: OptionSpec = {
  cwd: { type: "string", short: "C" },
  engine: { type: "string" },
  "engine-preset": { type: "string" },
  "base-url": { type: "string" },
  "api-key-env": { type: "string" },
  model: { type: "string", short: "m" },
  agent: { type: "string" },
  config: { type: "string" },
  lang: { type: "string" },
  timeout: { type: "string" },
  "max-diff": { type: "string" },
  "max-file": { type: "string" },
  "max-cost": { type: "string" },
  output: { type: "string", short: "o" },
  format: { type: "string" },
  "no-repo-context": { type: "boolean" },
  "fail-on": { type: "string" },
  rules: { type: "string" },
  json: { type: "boolean" },
  "dry-run": { type: "boolean" },
  verbose: { type: "boolean" },
  strict: { type: "boolean" },
  github: { type: "boolean" },
  "no-cache": { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

export function withCommon(extra: OptionSpec): OptionSpec {
  return { ...COMMON_OPTIONS, ...extra };
}

export interface ParsedCommand {
  values: ArgsValues;
  positionals: string[];
}

export function parseCommandArgs(args: string[], options: OptionSpec): ParsedCommand {
  try {
    const parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
    return { values: parsed.values as ArgsValues, positionals: parsed.positionals };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PilotError(`Ошибка аргументов: ${message}`, {
      hint: "Проверьте команду: oc-pilot <команда> --help",
      exitCode: 2,
    });
  }
}

function parseOutputFormat(value: string): OutputFormat {
  const normalized = value.trim().toLowerCase();
  if (normalized === "text" || normalized === "json" || normalized === "sarif") return normalized;
  throw new PilotError(`Некорректный --format: ${value}`, {
    hint: "Допустимые значения: text, json, sarif",
    exitCode: 2,
  });
}

/** `--max-cost` takes a plain USD amount such as `0.5` or `2`. */
function parseCost(value: string): number {
  const normalized = value.trim().replace(",", ".");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new PilotError(`Некорректный --max-cost: ${value}`, {
      hint: "Ожидается положительное число в долларах, например 0.5",
      exitCode: 2,
    });
  }
  return parsed;
}

export function resolveContext(values: ArgsValues): CommandContext {
  const rawCwd = asString(values, "cwd");
  const cwd = rawCwd ? resolve(process.cwd(), rawCwd) : process.cwd();
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new PilotError(`Директория не найдена: ${cwd}`, { exitCode: 2 });
  }

  const overrides: ConfigOverrides = {};
  const engine = asString(values, "engine");
  const baseUrl = asString(values, "base-url");
  const apiKeyEnv = asString(values, "api-key-env");
  const model = asString(values, "model");
  const agent = asString(values, "agent");
  const maxDiff = asString(values, "max-diff");
  const maxFile = asString(values, "max-file");
  const timeout = asString(values, "timeout");
  const failOn = asString(values, "fail-on");
  const rules = asString(values, "rules");
  const lang = asString(values, "lang");

  if (engine !== undefined) overrides.engine = parseEngine(engine);
  if (baseUrl !== undefined) overrides.baseUrl = parseBaseUrl(baseUrl);
  if (apiKeyEnv !== undefined) overrides.apiKeyEnv = apiKeyEnv;
  if (model !== undefined) overrides.model = model;

  const presetName = asString(values, "engine-preset");
  if (presetName !== undefined) {
    const preset = parseEnginePreset(presetName);
    if (engine === undefined) overrides.engine = "openai";
    if (baseUrl === undefined) overrides.baseUrl = preset.baseUrl;
    if (apiKeyEnv === undefined) overrides.apiKeyEnv = preset.apiKeyEnv;
    if (model === undefined && preset.model !== undefined) overrides.model = preset.model;
  }
  if (agent !== undefined) overrides.agent = agent;
  if (maxDiff !== undefined) overrides.maxDiffChars = parseSize(maxDiff, "max-diff");
  if (maxFile !== undefined) overrides.maxFileChars = parseSize(maxFile, "max-file");
  const maxCost = asString(values, "max-cost");
  if (maxCost !== undefined) overrides.maxCostUsd = parseCost(maxCost);
  if (timeout !== undefined) overrides.timeoutSeconds = parseSeconds(timeout, "timeout");
  if (lang !== undefined) overrides.lang = parsePromptLang(lang);
  if (failOn !== undefined) {
    try {
      overrides.failOn = parseFailOn(failOn);
    } catch (error) {
      throw new PilotError("Некорректный --fail-on", {
        hint: error instanceof Error ? error.message : String(error),
        exitCode: 2,
      });
    }
  }
  if (asBoolean(values, "no-repo-context")) overrides.repoContext = false;
  if (rules !== undefined) overrides.rules = rules;

  const loaded = loadConfig({
    cwd,
    explicitPath: asString(values, "config"),
    overrides,
  });

  const outputRaw = asString(values, "output");
  const formatRaw = asString(values, "format");
  const format = formatRaw !== undefined ? parseOutputFormat(formatRaw) : undefined;

  return {
    cwd,
    config: loaded.config,
    configPath: loaded.path,
    flags: {
      cwd,
      json: format === "json" ? true : asBoolean(values, "json"),
      dryRun: asBoolean(values, "dry-run"),
      verbose: asBoolean(values, "verbose"),
      strict: asBoolean(values, "strict"),
      github: asBoolean(values, "github"),
      noCache: asBoolean(values, "no-cache"),
      output: outputRaw ? resolve(cwd, outputRaw) : undefined,
      format,
    },
  };
}

export const COMMON_HELP = `  -C, --cwd <dir>       Рабочая директория (по умолчанию текущая)
      --engine <name>   Движок: opencode (по умолчанию), openai или anthropic
      --engine-preset <p> Пресет openai-совместимого API: ollama, lmstudio, openrouter
      --base-url <url>  Base URL OpenAI-совместимого API (engine=openai)
      --api-key-env <n> Переменная с API-ключом (по умолчанию OC_PILOT_API_KEY)
  -m, --model <id>      Модель: provider/model для OpenCode или имя модели для API
      --agent <name>    Агент OpenCode (по умолчанию oc-pilot: read-only контекст)
      --no-repo-context Запретить агенту читать файлы проекта (только diff)
      --lang <en|ru>    Язык ответа модели (по умолчанию en)
      --config <path>   Путь к .oc-pilot.json
      --rules <path>    Файл правил проекта (по умолчанию .oc-pilot/rules.md)
      --timeout <dur>   Таймаут запроса: секунды или 5m (по умолчанию 300)
      --max-diff <size> Лимит diff: 120k, 1m (по умолчанию 120000)
      --max-file <size> Лимит одного файла для docgen (по умолчанию 60000)
      --max-cost <usd>  Дневной лимит расходов в долларах (openai)
      --fail-on <level> Exit 3 при замечаниях: critical, warning, style, none
  -o, --output <path>   Записать результат в файл
      --format <f>      Формат вывода: text, json, sarif (scan/review)
      --json            Машиночитаемый JSON в stdout
      --dry-run         Показать промпт, не вызывать модель
      --strict          Код 3, если ответ не соответствует OUTPUT SCHEMA
      --github          Печатать GitHub Actions annotations для findings
      --no-cache        Не использовать кеш ответов движка (openai)
      --verbose         Подробный вывод OpenCode
  -h, --help            Показать помощь`;
