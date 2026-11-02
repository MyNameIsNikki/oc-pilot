import type { PromptLang } from "../types.js";
import { PilotError } from "./errors.js";

export const PROMPT_LANGS: PromptLang[] = ["en", "ru"];

export function isPromptLang(value: string): value is PromptLang {
  return value === "en" || value === "ru";
}

export function parsePromptLang(value: string, source = "--lang"): PromptLang {
  const normalized = value.trim().toLowerCase();
  if (normalized === "en" || normalized === "english") return "en";
  if (normalized === "ru" || normalized === "russian" || normalized === "рус") return "ru";
  throw new PilotError(`Некорректное значение ${source}: ${value}`, {
    hint: "Допустимо: en, ru.",
    exitCode: 2,
  });
}
