import { PilotError } from "./errors.js";
export const PROMPT_LANGS = ["en", "ru"];
export function isPromptLang(value) {
    return value === "en" || value === "ru";
}
export function parsePromptLang(value, source = "--lang") {
    const normalized = value.trim().toLowerCase();
    if (isPromptLang(normalized))
        return normalized;
    if (normalized === "english")
        return "en";
    if (normalized === "russian" || normalized === "рус")
        return "ru";
    throw new PilotError(`Некорректное значение ${source}: ${value}`, {
        hint: `Допустимо: ${PROMPT_LANGS.join(", ")}.`,
        exitCode: 2,
    });
}
//# sourceMappingURL=lang.js.map