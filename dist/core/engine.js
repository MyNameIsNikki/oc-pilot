import { PilotError } from "./errors.js";
export const ENGINES = ["opencode", "openai"];
export const DEFAULT_API_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_API_KEY_ENV = "OC_PILOT_API_KEY";
export function isEngine(value) {
    return value === "opencode" || value === "openai";
}
export function parseEngine(value, source = "--engine") {
    const normalized = value.trim().toLowerCase();
    if (isEngine(normalized))
        return normalized;
    throw new PilotError(`Некорректное значение ${source}: ${value}`, {
        hint: "Допустимо: opencode, openai (OpenAI-совместимый API).",
        exitCode: 2,
    });
}
export function normalizeBaseUrl(value) {
    return (value?.trim() || DEFAULT_API_BASE_URL).replace(/\/+$/, "");
}
export function parseBaseUrl(value, source = "--base-url") {
    const raw = value.trim();
    if (!raw) {
        throw new PilotError(`Пустой ${source}`, { exitCode: 2 });
    }
    let url;
    try {
        url = new URL(raw);
    }
    catch {
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
export function isLoopbackUrl(value) {
    try {
        const host = new URL(value).hostname.toLowerCase();
        return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
    }
    catch {
        return false;
    }
}
export function resolveApiKey(apiKeyEnv) {
    const envName = apiKeyEnv?.trim() || DEFAULT_API_KEY_ENV;
    let key = process.env[envName]?.trim() || undefined;
    // A zero-config OpenAI setup should work out of the box. Never fall back
    // silently when the user selected a different environment variable.
    if (!key && envName === DEFAULT_API_KEY_ENV)
        key = process.env.OPENAI_API_KEY?.trim() || undefined;
    return { key, envName };
}
function endpointFor(baseUrl) {
    if (/\/chat\/completions$/i.test(baseUrl))
        return baseUrl;
    return `${baseUrl}/chat/completions`;
}
function contentOf(response) {
    const content = response.choices?.[0]?.message?.content;
    if (typeof content === "string")
        return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => (part && typeof part.text === "string" ? part.text : ""))
            .filter(Boolean)
            .join("\n");
    }
    return "";
}
function sanitize(message, apiKey) {
    let value = message.trim();
    if (apiKey)
        value = value.split(apiKey).join("[REDACTED:API key]");
    return value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value;
}
/**
 * Calls an OpenAI-compatible /chat/completions endpoint.
 * Works with OpenAI, DeepSeek, Groq, OpenRouter, vLLM, Ollama and similar
 * services. No provider SDK is required.
 */
export async function runOpenAiCompatible(options) {
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
    const headers = {
        "content-type": "application/json",
        accept: "application/json",
    };
    if (key)
        headers.authorization = `Bearer ${key}`;
    let response;
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
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const timedOut = /abort|timeout/i.test(message);
        throw new PilotError(timedOut ? "OpenAI-совместимый API не ответил вовремя" : "Не удалось подключиться к API", {
            hint: timedOut
                ? `Увеличьте --timeout (сейчас ${Math.round(options.timeoutMs / 1000)} с).`
                : `${baseUrl}: ${sanitize(message, key)}`,
            exitCode: 1,
        });
    }
    const raw = await response.text();
    if (!response.ok) {
        let detail = raw;
        try {
            const parsed = JSON.parse(raw);
            detail = parsed.error?.message || raw;
        }
        catch {
            // Keep the raw body.
        }
        throw new PilotError(`API вернул HTTP ${response.status}`, {
            hint: sanitize(detail, key),
            exitCode: 1,
        });
    }
    let payload;
    try {
        payload = JSON.parse(raw);
    }
    catch {
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
        durationMs: Date.now() - started,
        stderr: "",
    };
}
//# sourceMappingURL=engine.js.map