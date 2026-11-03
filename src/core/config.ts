import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ConfigOverrides, Engine, FailOn, LoadedConfig, PromptLang, ResolvedConfig } from "../types.js";
import { DEFAULT_CACHE_TTL_SECONDS } from "./cache.js";
import { parseBaseUrl, parseEngine } from "./engine.js";
import { PilotError } from "./errors.js";
import { parseFailOn } from "./findings.js";
import { parsePromptLang } from "./lang.js";
import { log } from "./log.js";

const CONFIG_FILENAME = ".oc-pilot.json";

export const DEFAULT_CONFIG: ResolvedConfig = {
  engine: "opencode",
  agent: "oc-pilot",
  maxDiffChars: 120_000,
  maxOutputChars: 40_000,
  timeoutSeconds: 300,
  redactSecrets: true,
  maxFileChars: 60_000,
  repoContext: true,
  failOn: "none",
  lang: "en",
  cacheTtlSeconds: DEFAULT_CACHE_TTL_SECONDS,
  agentRules: true,
  maxDailyApiCalls: 0,
  maxCostUsd: 0,
};

interface LoadOptions {
  cwd: string;
  explicitPath?: string;
  overrides?: ConfigOverrides;
}

function findConfigFile(start: string): string | undefined {
  let directory = resolve(start);
  for (let depth = 0; depth < 32; depth += 1) {
    const candidate = join(directory, CONFIG_FILENAME);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

function readObject(file: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    throw new PilotError(`Не удалось прочитать конфиг ${file}`, { hint: String(error) });
  }

  try {
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new PilotError(`Конфиг ${file} должен быть JSON-объектом`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof PilotError) throw error;
    throw new PilotError(`Некорректный JSON в ${file}`, { hint: String(error) });
  }
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new PilotError(`Поле ${name} в конфиге должно быть непустой строкой`);
  }
  return value.trim();
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new PilotError(`Поле ${name} в конфиге должно быть boolean`);
  }
  return value;
}

function optionalPositiveInt(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new PilotError(`Поле ${name} в конфиге должно быть положительным целым числом`);
  }
  return value;
}

function optionalNonNegativeInt(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new PilotError(`Поле ${name} в конфиге должно быть целым числом >= 0`);
  }
  return value;
}

function optionalNonNegativeNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new PilotError(`Поле ${name} в конфиге должно быть числом >= 0`);
  }
  return value;
}

function optionalFailOn(value: unknown, name: string): FailOn | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new PilotError(`Поле ${name} в конфиге должно быть строкой: none, critical, warning или style`);
  }
  try {
    return parseFailOn(value);
  } catch (error) {
    throw new PilotError(`Некорректное значение ${name} в конфиге`, {
      hint: error instanceof Error ? error.message : String(error),
    });
  }
}

function optionalLang(value: unknown, name: string): PromptLang | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new PilotError(`Поле ${name} в конфиге должно быть строкой: en или ru`);
  }
  return parsePromptLang(value, name);
}

function optionalEngine(value: unknown, name: string): Engine | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new PilotError(`Поле ${name} в конфиге должно быть строкой: opencode или openai`);
  }
  return parseEngine(value, name);
}

function optionalBaseUrl(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new PilotError(`Поле ${name} в конфиге должно быть непустым URL`);
  }
  return parseBaseUrl(value, name);
}

function fromFile(file: string): Partial<ResolvedConfig> {
  const data = readObject(file);
  const known = new Set([
    "$schema",
    "engine",
    "model",
    "agent",
    "baseUrl",
    "apiKeyEnv",
    "maxDiffChars",
    "maxOutputChars",
    "timeoutSeconds",
    "testCommand",
    "redactSecrets",
    "maxFileChars",
    "repoContext",
    "failOn",
    "rules",
    "lang",
    "routerEnabled",
    "routerModel",
    "cacheTtlSeconds",
    "secondOpinionEnabled",
    "secondOpinionModel",
    "secondOpinionBaseUrl",
    "secondOpinionApiKeyEnv",
    "agentRules",
    "maxDailyApiCalls",
    "maxCostUsd",
  ]);

  for (const key of Object.keys(data)) {
    if (!known.has(key)) log.warn(`Неизвестное поле в ${CONFIG_FILENAME}: ${key} (проигнорировано)`);
  }

  return {
    engine: optionalEngine(data.engine, "engine"),
    model: optionalString(data.model, "model"),
    agent: optionalString(data.agent, "agent"),
    baseUrl: optionalBaseUrl(data.baseUrl, "baseUrl"),
    apiKeyEnv: optionalString(data.apiKeyEnv, "apiKeyEnv"),
    maxDiffChars: optionalPositiveInt(data.maxDiffChars, "maxDiffChars"),
    maxOutputChars: optionalPositiveInt(data.maxOutputChars, "maxOutputChars"),
    timeoutSeconds: optionalPositiveInt(data.timeoutSeconds, "timeoutSeconds"),
    testCommand: optionalString(data.testCommand, "testCommand"),
    redactSecrets: optionalBoolean(data.redactSecrets, "redactSecrets"),
    maxFileChars: optionalPositiveInt(data.maxFileChars, "maxFileChars"),
    repoContext: optionalBoolean(data.repoContext, "repoContext"),
    failOn: optionalFailOn(data.failOn, "failOn"),
    rules: optionalString(data.rules, "rules"),
    lang: optionalLang(data.lang, "lang"),
    routerEnabled: optionalBoolean(data.routerEnabled, "routerEnabled"),
    routerModel: optionalString(data.routerModel, "routerModel"),
    cacheTtlSeconds: optionalNonNegativeInt(data.cacheTtlSeconds, "cacheTtlSeconds"),
    secondOpinionEnabled: optionalBoolean(data.secondOpinionEnabled, "secondOpinionEnabled"),
    secondOpinionModel: optionalString(data.secondOpinionModel, "secondOpinionModel"),
    secondOpinionBaseUrl: optionalString(data.secondOpinionBaseUrl, "secondOpinionBaseUrl"),
    secondOpinionApiKeyEnv: optionalString(data.secondOpinionApiKeyEnv, "secondOpinionApiKeyEnv"),
    agentRules: optionalBoolean(data.agentRules, "agentRules"),
    maxDailyApiCalls: optionalNonNegativeInt(data.maxDailyApiCalls, "maxDailyApiCalls"),
    maxCostUsd: optionalNonNegativeNumber(data.maxCostUsd, "maxCostUsd"),
  };
}

function envPositiveInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new PilotError(`Переменная окружения ${name} должна быть положительным целым числом`);
  }
  return value;
}

function envNonNegativeNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new PilotError(`Некорректное значение ${name}: ожидается число >= 0`);
  }
  return value;
}

function envNonNegativeInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new PilotError(`Переменная окружения ${name} должна быть целым числом >= 0`);
  }
  return value;
}

function envBoolean(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new PilotError(`Переменная окружения ${name} должна быть true или false`);
}

function envFailOn(): FailOn | undefined {
  const raw = process.env.OC_PILOT_FAIL_ON;
  if (raw === undefined || raw.trim() === "") return undefined;
  try {
    return parseFailOn(raw);
  } catch (error) {
    throw new PilotError("Некорректное значение OC_PILOT_FAIL_ON", {
      hint: error instanceof Error ? error.message : String(error),
    });
  }
}

function envLang(): PromptLang | undefined {
  const raw = process.env.OC_PILOT_LANG;
  if (raw === undefined || raw.trim() === "") return undefined;
  return parsePromptLang(raw, "OC_PILOT_LANG");
}

function envEngine(): Engine | undefined {
  const raw = process.env.OC_PILOT_ENGINE;
  if (raw === undefined || raw.trim() === "") return undefined;
  return parseEngine(raw, "OC_PILOT_ENGINE");
}

function envBaseUrl(): string | undefined {
  const raw = process.env.OC_PILOT_BASE_URL;
  if (raw === undefined || raw.trim() === "") return undefined;
  return parseBaseUrl(raw, "OC_PILOT_BASE_URL");
}

function fromEnv(): Partial<ResolvedConfig> {
  return {
    engine: envEngine(),
    model: process.env.OC_PILOT_MODEL?.trim() || undefined,
    agent: process.env.OC_PILOT_AGENT?.trim() || undefined,
    baseUrl: envBaseUrl(),
    apiKeyEnv: process.env.OC_PILOT_API_KEY_ENV?.trim() || undefined,
    maxDiffChars: envPositiveInt("OC_PILOT_MAX_DIFF_CHARS"),
    maxOutputChars: envPositiveInt("OC_PILOT_MAX_OUTPUT_CHARS"),
    timeoutSeconds: envPositiveInt("OC_PILOT_TIMEOUT_SECONDS"),
    testCommand: process.env.OC_PILOT_TEST_COMMAND?.trim() || undefined,
    redactSecrets: envBoolean("OC_PILOT_REDACT_SECRETS"),
    maxFileChars: envPositiveInt("OC_PILOT_MAX_FILE_CHARS"),
    repoContext: envBoolean("OC_PILOT_REPO_CONTEXT"),
    failOn: envFailOn(),
    rules: process.env.OC_PILOT_RULES?.trim() || undefined,
    lang: envLang(),
    routerEnabled: envBoolean("OC_PILOT_ROUTER"),
    routerModel: process.env.OC_PILOT_ROUTER_MODEL?.trim() || undefined,
    cacheTtlSeconds: envNonNegativeInt("OC_PILOT_CACHE_TTL"),
    secondOpinionEnabled: envBoolean("OC_PILOT_SECOND_OPINION"),
    secondOpinionModel: process.env.OC_PILOT_SECOND_OPINION_MODEL?.trim() || undefined,
    secondOpinionBaseUrl: process.env.OC_PILOT_SECOND_OPINION_BASE_URL?.trim() || undefined,
    secondOpinionApiKeyEnv: process.env.OC_PILOT_SECOND_OPINION_API_KEY_ENV?.trim() || undefined,
    agentRules: envBoolean("OC_PILOT_AGENT_RULES"),
    maxDailyApiCalls: envNonNegativeInt("OC_PILOT_MAX_DAILY_API_CALLS"),
    maxCostUsd: envNonNegativeNumber("OC_PILOT_MAX_COST"),
  };
}

function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

export function loadConfig(options: LoadOptions): LoadedConfig {
  const explicit = options.explicitPath
    ? isAbsolute(options.explicitPath)
      ? options.explicitPath
      : resolve(options.cwd, options.explicitPath)
    : undefined;

  if (explicit && !existsSync(explicit)) {
    throw new PilotError(`Конфиг не найден: ${explicit}`, {
      hint: `Создайте файл ${CONFIG_FILENAME} командой oc-pilot init.`,
      exitCode: 2,
    });
  }

  const path = explicit ?? findConfigFile(options.cwd);
  const fileValues = path ? fromFile(path) : {};
  const merged: ResolvedConfig = {
    ...DEFAULT_CONFIG,
    ...defined(fileValues),
    ...defined(fromEnv()),
    ...defined(options.overrides ?? {}),
  };

  if (!merged.agent.trim()) throw new PilotError("agent не может быть пустым");
  if (merged.model !== undefined && !merged.model.trim()) {
    throw new PilotError("model не может быть пустым");
  }
  if (merged.testCommand !== undefined && !merged.testCommand.trim()) {
    throw new PilotError("testCommand не может быть пустым");
  }

  return { config: merged, path };
}

export function configTemplate(): string {
  return `${JSON.stringify(
    {
      engine: DEFAULT_CONFIG.engine,
      agent: DEFAULT_CONFIG.agent,
      maxDiffChars: DEFAULT_CONFIG.maxDiffChars,
      maxOutputChars: DEFAULT_CONFIG.maxOutputChars,
      timeoutSeconds: DEFAULT_CONFIG.timeoutSeconds,
      redactSecrets: DEFAULT_CONFIG.redactSecrets,
      maxFileChars: DEFAULT_CONFIG.maxFileChars,
      repoContext: DEFAULT_CONFIG.repoContext,
      failOn: DEFAULT_CONFIG.failOn,
      lang: DEFAULT_CONFIG.lang,
      routerEnabled: false,
      routerModel: "gpt-4.1-mini",
      cacheTtlSeconds: DEFAULT_CACHE_TTL_SECONDS,
      secondOpinionEnabled: false,
      agentRules: true,
      maxDailyApiCalls: 0,
      maxCostUsd: 0,
    },
    null,
    2,
  )}\n`;
}
