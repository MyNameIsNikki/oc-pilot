import { PilotError } from "./errors.js";

export interface BlindfoldMapping {
  original: string;
  replacement: string;
}

export interface BlindfoldObfuscation {
  code: string;
  mapping: BlindfoldMapping[];
}

export interface BlindfoldVerdict {
  understood: boolean;
  vulnerability: boolean;
  confidence: number;
  explanation: string;
}

export type BlindfoldStatus = "pass" | "fail" | "error";

export interface BlindfoldReport {
  source: string;
  file?: string;
  status: BlindfoldStatus;
  summary: string;
  verdict?: BlindfoldVerdict;
  mapping: BlindfoldMapping[];
  obfuscated?: string;
}

const KEYWORDS = new Set([
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "get",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "of",
  "return",
  "set",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "constructor",
]);

const BUILTINS = new Set([
  "AbortController",
  "AbortSignal",
  "Array",
  "BigInt",
  "Boolean",
  "Buffer",
  "Date",
  "Error",
  "Function",
  "Infinity",
  "Intl",
  "JSON",
  "Map",
  "Math",
  "NaN",
  "Number",
  "Object",
  "Promise",
  "Proxy",
  "Reflect",
  "RegExp",
  "Set",
  "String",
  "Symbol",
  "TextDecoder",
  "TextEncoder",
  "URL",
  "URLSearchParams",
  "WeakMap",
  "WeakSet",
  "__dirname",
  "__filename",
  "any",
  "bigint",
  "boolean",
  "clearInterval",
  "clearTimeout",
  "console",
  "crypto",
  "document",
  "eval",
  "exports",
  "fetch",
  "globalThis",
  "isNaN",
  "module",
  "never",
  "number",
  "object",
  "parseFloat",
  "parseInt",
  "performance",
  "process",
  "queueMicrotask",
  "require",
  "setInterval",
  "setTimeout",
  "string",
  "structuredClone",
  "symbol",
  "unknown",
  "void",
  "window",
]);

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;

function isWordChar(char: string | undefined): boolean {
  return typeof char === "string" && /[A-Za-z0-9_$]/.test(char);
}

function previousSignificant(text: string, index: number): { char?: string; word?: string } {
  let at = index - 1;
  while (at >= 0 && /\s/.test(text[at]!)) at -= 1;
  if (at < 0) return {};
  const char = text[at]!;
  if (isWordChar(char)) {
    let start = at;
    while (start > 0 && isWordChar(text[start - 1]!)) start -= 1;
    return { char, word: text.slice(start, at + 1) };
  }
  if (char === "." && text[at - 1] === "?") return { char: "?." };
  return { char };
}

function nextSignificant(text: string, index: number): string | undefined {
  let at = index;
  while (at < text.length && /\s/.test(text[at]!)) at += 1;
  return text[at];
}

function looksLikeRegexStart(previous: { char?: string; word?: string }): boolean {
  if (!previous.char) return true;
  if (previous.word) {
    return new Set(["case", "delete", "in", "instanceof", "new", "of", "return", "typeof", "void"]).has(
      previous.word,
    );
  }
  return "=(:,![{;?&|+-*%^~<>".includes(previous.char);
}

function skipQuoted(text: string, start: number): number {
  const quote = text[start]!;
  let at = start + 1;
  while (at < text.length) {
    if (text[at] === "\\") {
      at += 2;
      continue;
    }
    if (text[at] === quote) return at + 1;
    at += 1;
  }
  return text.length;
}

function skipTemplate(text: string, start: number): number {
  let at = start + 1;
  while (at < text.length) {
    if (text[at] === "\\") {
      at += 2;
      continue;
    }
    if (text[at] === "`") return at + 1;
    at += 1;
  }
  return text.length;
}

function skipComment(text: string, start: number): number {
  if (text[start + 1] === "/") {
    const end = text.indexOf("\n", start + 2);
    return end === -1 ? text.length : end;
  }
  const end = text.indexOf("*/", start + 2);
  return end === -1 ? text.length : end + 2;
}

function skipRegex(text: string, start: number): number {
  let at = start + 1;
  let inClass = false;
  while (at < text.length) {
    const char = text[at]!;
    if (char === "\\") {
      at += 2;
      continue;
    }
    if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) {
      at += 1;
      while (at < text.length && /[a-z]/i.test(text[at]!)) at += 1;
      return at;
    }
    at += 1;
  }
  return text.length;
}

function collectIdentifiers(code: string): Set<string> {
  const found = new Set<string>();
  for (const match of code.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) found.add(match[0]);
  return found;
}

function base26(value: number): string {
  let index = value;
  let out = "";
  do {
    out = String.fromCharCode(65 + (index % 26)) + out;
    index = Math.floor(index / 26) - 1;
  } while (index >= 0);
  return out;
}

/** Deterministically renames identifiers while keeping syntax and literals intact. */
export function obfuscateCode(code: string): BlindfoldObfuscation {
  const taken = collectIdentifiers(code);
  const mapping = new Map<string, string>();
  const counters = { fn: 0, type: 0, var: 0 };
  const used = new Set<string>();
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let out = "";
  let index = 0;

  const rename = (word: string, prefix: "fn" | "type" | "var"): string => {
    const existing = mapping.get(word);
    if (existing) return existing;
    let replacement = "";
    do {
      replacement = `${prefix}_${base26(counters[prefix])}`;
      counters[prefix] += 1;
    } while (taken.has(replacement) || used.has(replacement));
    used.add(replacement);
    mapping.set(word, replacement);
    return replacement;
  };

  while (index < code.length) {
    const char = code[index]!;

    if (char === "/" && code[index + 1] === "/") {
      const end = skipComment(code, index);
      out += code.slice(index, end);
      index = end;
      continue;
    }
    if (char === "/" && code[index + 1] === "*") {
      const end = skipComment(code, index);
      out += code.slice(index, end);
      index = end;
      continue;
    }
    if (char === "'" || char === '"') {
      const end = skipQuoted(code, index);
      out += code.slice(index, end);
      index = end;
      continue;
    }
    if (char === "`") {
      const end = skipTemplate(code, index);
      out += code.slice(index, end);
      index = end;
      continue;
    }
    if (char === "/") {
      const previous = previousSignificant(code, index);
      if (looksLikeRegexStart(previous)) {
        const end = skipRegex(code, index);
        out += code.slice(index, end);
        index = end;
        continue;
      }
    }

    if (char === "#" && IDENT_START.test(code[index + 1] ?? "")) {
      let end = index + 2;
      while (end < code.length && IDENT_PART.test(code[end]!)) end += 1;
      out += code.slice(index, end);
      index = end;
      continue;
    }

    if (IDENT_START.test(char)) {
      let end = index + 1;
      while (end < code.length && IDENT_PART.test(code[end]!)) end += 1;
      const word = code.slice(index, end);
      const previous = previousSignificant(code, index);
      const next = nextSignificant(code, end);
      const beforePrevious = previous.word ? previousSignificant(code, index - previous.word.length) : previous;

      const propertyAccess = previous.char === "." || previous.char === "?.";
      const objectKey =
        next === ":" &&
        braceDepth > parenDepth &&
        (previous.char === "{" || previous.char === "," || previous.char === ";");
      const methodName =
        next === "(" &&
        braceDepth > 0 &&
        (previous.char === "{" || previous.char === "}" || previous.char === ";" || previous.char === "*");
      const accessorName = previous.word === "get" || previous.word === "set";
      const importName = previous.word === "import" || previous.word === "from" || beforePrevious.word === "import";

      if (
        KEYWORDS.has(word) ||
        BUILTINS.has(word) ||
        propertyAccess ||
        objectKey ||
        methodName ||
        accessorName ||
        importName
      ) {
        out += word;
        index = end;
        continue;
      }

      const prefix: "fn" | "type" | "var" =
        previous.word === "class" || previous.word === "new" || /^[A-Z]/.test(word)
          ? "type"
          : next === "(" || previous.word === "function"
            ? "fn"
            : "var";
      out += rename(word, prefix);
      index = end;
      continue;
    }

    if (char === "{") braceDepth += 1;
    if (char === "}") braceDepth = Math.max(0, braceDepth - 1);
    if (char === "(") parenDepth += 1;
    if (char === ")") parenDepth = Math.max(0, parenDepth - 1);
    if (char === "[") bracketDepth += 1;
    if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    out += char;
    index += 1;
  }

  return {
    code: out,
    mapping: [...mapping.entries()].map(([original, replacement]) => ({ original, replacement })),
  };
}

export function buildBlindfoldPrompt(obfuscated: string, context?: string): string {
  return [
    "You are auditing code whose identifiers were removed.",
    "Every function, variable, class and type name was replaced with fn_A, var_A or type_A.",
    "Reason only from control flow, data flow and syntax; do not guess the original names.",
    "Find real defects: division by zero, injection, auth bypass, unbounded loops, null dereference, race conditions or unsafe deserialization.",
    context ? `Extra context from the author:\n${context}` : "",
    "Return strict JSON only, with no markdown and no prose outside the object:",
    '{"understood":true,"vulnerability":false,"confidence":0.8,"explanation":"one short paragraph"}',
    "Set understood=false if the behavior cannot be determined from the snippet.",
    "Set vulnerability=true if any concrete defect is present.",
    "confidence must be a number from 0 to 1.",
    "",
    "CODE:",
    obfuscated,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function asBooleanField(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function parseBlindfoldVerdict(text: string): BlindfoldVerdict | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  const understood = asBooleanField(record.understood);
  const vulnerability = asBooleanField(record.vulnerability);
  const confidence = typeof record.confidence === "number" ? record.confidence : undefined;
  const explanation = typeof record.explanation === "string" ? record.explanation.trim() : undefined;
  if (understood === undefined || vulnerability === undefined || confidence === undefined || !explanation) {
    return undefined;
  }
  return {
    understood,
    vulnerability,
    confidence: Math.max(0, Math.min(1, confidence)),
    explanation,
  };
}

export function judgeBlindfold(
  verdict: BlindfoldVerdict | undefined,
  minConfidence: number,
): { status: BlindfoldStatus; summary: string } {
  if (!verdict) {
    return { status: "error", summary: "[BLINDFOLD ERROR]: модель не вернула JSON-вердикт." };
  }
  if (!verdict.understood) {
    return {
      status: "fail",
      summary: `[BLINDFOLD REJECTED]: модель не смогла восстановить логику без имён. ${verdict.explanation}`,
    };
  }
  if (verdict.vulnerability) {
    return {
      status: "fail",
      summary: `[BLINDFOLD REJECTED]: найдена уязвимость. ${verdict.explanation}`,
    };
  }
  if (verdict.confidence < minConfidence) {
    return {
      status: "fail",
      summary: `[BLINDFOLD REJECTED]: уверенность ${verdict.confidence.toFixed(2)} ниже порога ${minConfidence.toFixed(2)}. ${verdict.explanation}`,
    };
  }
  return { status: "pass", summary: "Код понятен без имён, уязвимостей не найдено." };
}

export function renderBlindfold(report: BlindfoldReport): string {
  const lines = [`Blindfold: ${report.status}`, `Source: ${report.source}`];
  if (report.file) lines.push(`File: ${report.file}`);
  lines.push(`Identifiers hidden: ${String(report.mapping.length)}`);
  if (report.verdict) {
    lines.push(
      `Verdict: understood=${String(report.verdict.understood)}, vulnerability=${String(report.verdict.vulnerability)}, confidence=${report.verdict.confidence.toFixed(2)}`,
    );
    lines.push(report.verdict.explanation);
  }
  lines.push(report.summary);
  return `${lines.join("\n")}\n`;
}

export function parseMinConfidence(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 0.6;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new PilotError(`Некорректный порог уверенности: ${raw}`, {
      hint: "Используйте число от 0 до 1, например 0.6.",
      exitCode: 2,
    });
  }
  return value;
}
