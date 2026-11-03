import type { AnalysisResult } from "../types.js";
import { PilotError } from "./errors.js";
import { log } from "./log.js";

export const ENGINES = ["opencode", "openai"] as const;
export type Engine = (typeof ENGINES)[number];

export const DEFAULT_API_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_API_KEY_ENV = "OC_PILOT_API_KEY";

export function isEngine(value: unknown): value is Engine {
  return value === "opencode" || value === "openai";
}

export function parseEngine(value: string, source = "--engine"): Engine {
  const normalized = value.trim().toLowerCase();
  if (isEngine(normalized)) return normalized;
  throw new PilotError(`Некорректное значение ${source}: ${value}`, {
    hint: "Допустимо: opencode, openai (OpenAI-совместимый API).",
    exitCode: 2,
  });
}

export interface EnginePreset {
  id: string;
  baseUrl: string;
  apiKeyEnv: string;
  model?: string;
  note: string;
}

/**
 * Ready-made endpoints for OpenAI-compatible providers. They only change the
 * defaults, so any explicit --base-url, --api-key-env or --model still wins.
 */
export const ENGINE_PRESETS: EnginePreset[] = [
  {
    id: "ollama",
    baseUrl: "http://localhost:11434/v1",
    apiKeyEnv: "OLLAMA_API_KEY",
    model: "llama3.2",
    note: "локальный Ollama, ключ не нужен",
  },
  {
    id: "lmstudio",
    baseUrl: "http://localhost:1234/v1",
    apiKeyEnv: "LMSTUDIO_API_KEY",
    note: "локальный LM Studio, ключ не нужен",
  },
  {
    id: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    note: "агрегатор OpenRouter",
  },
];

export function presetIds(): string[] {
  return ENGINE_PRESETS.map((preset) => preset.id);
}

export function findEnginePreset(id: string): EnginePreset | undefined {
  const normalized = id.trim().toLowerCase();
  return ENGINE_PRESETS.find((preset) => preset.id === normalized);
}

export function parseEnginePreset(value: string, source = "--engine-preset"): EnginePreset {
  const preset = findEnginePreset(value);
  if (preset) return preset;
  throw new PilotError(`Неизвестный пресет движка в ${source}: ${value}`, {
    hint: `Доступные пресеты: ${presetIds().join(", ")}`,
    exitCode: 2,
  });
}

export function normalizeBaseUrl(value: string | undefined): string {
  return (value?.trim() || DEFAULT_API_BASE_URL).replace(/\/+$/, "");
}

export function parseBaseUrl(value: string, source = "--base-url"): string {
  const raw = value.trim();
  if (!raw) {
    throw new PilotError(`Пустой ${source}`, { exitCode: 2 });
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PilotError(`Некорректный URL в ${source}: ${raw}`, {
      hint: "Пример: https://api.openai.com/v1",
      exitCode: 2,
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PilotError(`Поддерживаются только http и https в ${source}`, { exitCode: 2 });
  }
  if (url.username || url.password) {
    throw new PilotError(`${source} не должен содержать логин или пароль; используйте переменную окружения`, {
      exitCode: 2,
    });
  }
  return normalizeBaseUrl(raw);
}

export function isLoopbackUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

export function resolveApiKey(apiKeyEnv?: string): { key?: string; envName: string } {
  const envName = apiKeyEnv?.trim() || DEFAULT_API_KEY_ENV;
  let key = process.env[envName]?.trim() || undefined;
  // A zero-config OpenAI setup should work out of the box. Never fall back
  // silently when the user selected a different environment variable.
  if (!key && envName === DEFAULT_API_KEY_ENV) key = process.env.OPENAI_API_KEY?.trim() || undefined;
  return { key, envName };
}

export interface ApiRunOptions {
  systemPrompt: string;
  input: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  model?: string;
  timeoutMs: number;
  /** Total attempts including the first one. Defaults to 3. */
  retryAttempts?: number;
  /** Base delay for exponential backoff. Defaults to 500 ms; 0 in tests. */
  retryDelayMs?: number;
}

interface ChatResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  error?: { message?: string };
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

function endpointFor(baseUrl: string): string {
  if (/\/chat\/completions$/i.test(baseUrl)) return baseUrl;
  return `${baseUrl}/chat/completions`;
}

function contentOf(response: ChatResponse): string {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function sanitize(message: string, apiKey?: string): string {
  let value = message.trim();
  if (apiKey) value = value.split(apiKey).join("[REDACTED:API key]");
  return value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value;
}

export const DEFAULT_RETRY_ATTEMPTS = 3;
export const DEFAULT_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 8_000;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

function retryDelay(attempt: number, baseMs: number, header: string | null): number {
  const hinted = parseRetryAfter(header);
  if (hinted !== undefined) return Math.min(hinted, MAX_RETRY_DELAY_MS);
  return Math.min(baseMs * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
}

/**
 * Rough public list prices in USD per million tokens. They exist so `--max-cost`
 * can stop a runaway loop without asking the user to configure anything; pass
 * your own numbers in `.oc-pilot.json` when your provider bills differently.
 */
const MODEL_PRICES: Array<{ prefix: string; input: number; output: number }> = [
  { prefix: "gpt-4.1-mini", input: 0.4, output: 1.6 },
  { prefix: "gpt-4.1-nano", input: 0.1, output: 0.4 },
  { prefix: "gpt-4.1", input: 2, output: 8 },
  { prefix: "gpt-4o-mini", input: 0.15, output: 0.6 },
  { prefix: "gpt-4o", input: 2.5, output: 10 },
  { prefix: "o4-mini", input: 1.1, output: 4.4 },
  { prefix: "o3-mini", input: 1.1, output: 4.4 },
];

/** Estimated USD cost of one call, or undefined when the model is unknown. */
export function estimateCostUsd(
  model: string | undefined,
  usage: { promptTokens: number; completionTokens: number } | undefined,
  prices: Array<{ prefix: string; input: number; output: number }> = MODEL_PRICES,
): number | undefined {
  if (!usage) return undefined;
  const name = model?.trim().toLowerCase();
  if (!name) return undefined;
  const match = prices.find((entry) => name.startsWith(entry.prefix));
  if (!match) return undefined;
  const cost = (usage.promptTokens * match.input + usage.completionTokens * match.output) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/**
 * Calls an OpenAI-compatible /chat/completions endpoint.
 * Works with OpenAI, DeepSeek, Groq, OpenRouter, vLLM, Ollama and similar
 * services. No provider SDK is required.
 */
export async function runOpenAiCompatible(options: ApiRunOptions): Promise<AnalysisResult> {
  const started = Date.now();
  const baseUrl = parseBaseUrl(options.baseUrl ?? DEFAULT_API_BASE_URL, "baseUrl");
  const model = options.model?.trim();
  if (!model) {
    throw new PilotError("Для engine=openai нужна модель", {
      hint: "Укажите --model (например, gpt-4.1-mini или deepseek-chat) или поле model в .oc-pilot.json.",
      exitCode: 2,
    });
  }

  const { key, envName } = resolveApiKey(options.apiKeyEnv);
  if (!key && !isLoopbackUrl(baseUrl)) {
    throw new PilotError("Не найден API-ключ для engine=openai", {
      hint: `Экспортируйте ${envName} (или OPENAI_API_KEY). Для локального сервера без ключа используйте http://localhost.`,
      exitCode: 2,
    });
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (key) headers.authorization = `Bearer ${key}`;

  const attempts = Math.max(1, options.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS);
  const baseDelay = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);

  let ok = false;
  let status = 0;
  let raw = "";

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(endpointFor(baseUrl), {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: options.systemPrompt },
            { role: "user", content: options.input },
          ],
          temperature: 0.2,
          stream: false,
        }),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const timedOut = /abort|timeout/i.test(message);
      throw new PilotError(timedOut ? "OpenAI-совместимый API не ответил вовремя" : "Не удалось подключиться к API", {
        hint: timedOut
          ? `Увеличьте --timeout (сейчас ${Math.round(options.timeoutMs / 1000)} с).`
          : `${baseUrl}: ${sanitize(message, key)}`,
        exitCode: 1,
      });
    }

    status = response.status;
    raw = await response.text();
    if (response.ok) {
      ok = true;
      break;
    }
    if (!RETRYABLE_STATUS.has(status) || attempt === attempts) break;

    const delay = retryDelay(attempt, baseDelay, response.headers.get("retry-after"));
    const waitLabel = delay >= 1_000 ? `${Math.round(delay / 1_000)} с` : `${Math.round(delay)} мс`;
    log.warn(
      `API вернул HTTP ${status}; повтор через ${waitLabel} (попытка ${attempt + 1} из ${attempts}).`,
    );
    await wait(delay);
  }

  if (!ok) {
    let detail = raw;
    try {
      const parsed = JSON.parse(raw) as ChatResponse;
      detail = parsed.error?.message || raw;
    } catch {
      // Keep the raw body.
    }
    throw new PilotError(`API вернул HTTP ${status}`, {
      hint: sanitize(detail, key),
      exitCode: 1,
    });
  }

  let payload: ChatResponse;
  try {
    payload = JSON.parse(raw) as ChatResponse;
  } catch {
    throw new PilotError("API вернул некорректный JSON", {
      hint: sanitize(raw, key),
      exitCode: 1,
    });
  }

  const text = contentOf(payload);
  if (!text.trim()) {
    throw new PilotError("API вернул пустой ответ", {
      hint: "Проверьте модель и совместимость endpoint с /chat/completions.",
      exitCode: 1,
    });
  }

  return {
    text,
    ...(payload.usage
      ? {
          usage: {
            promptTokens: payload.usage.prompt_tokens ?? 0,
            completionTokens: payload.usage.completion_tokens ?? 0,
          },
        }
      : {}),
    durationMs: Date.now() - started,
    stderr: "",
  };
}
