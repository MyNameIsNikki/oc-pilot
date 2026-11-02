import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { SecretFinding } from "../types.js";
import { truncateText } from "./diff.js";
import { PilotError } from "./errors.js";
import { loadSecretIgnore, scanText } from "./secrets.js";

const DEFAULT_RULES_PATH = join(".oc-pilot", "rules.md");
const MAX_RULES_CHARS = 20_000;

function findDefaultRules(start: string): string | undefined {
  let directory = resolve(start);
  for (let depth = 0; depth < 32; depth += 1) {
    const candidate = join(directory, DEFAULT_RULES_PATH);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    const parent = resolve(directory, "..");
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

export interface LoadedRules {
  path: string;
  text: string;
  rawText: string;
  findings: SecretFinding[];
  truncated: boolean;
}

/**
 * Loads project review rules. An explicit path (config or --rules) must exist;
 * the conventional `.oc-pilot/rules.md` is optional.
 */
export function loadRules(cwd: string, explicitPath?: string): LoadedRules | undefined {
  const explicit = explicitPath !== undefined && explicitPath.trim() !== "";
  const absolute = explicit ? resolve(cwd, explicitPath!.trim()) : findDefaultRules(cwd);

  if (!absolute) return undefined;

  if (!existsSync(absolute)) {
    if (explicit) {
      throw new PilotError(`Файл правил не найден: ${absolute}`, {
        hint: "Создайте .oc-pilot/rules.md или уберите --rules / rules из конфига.",
        exitCode: 2,
      });
    }
    return undefined;
  }

  if (!statSync(absolute).isFile()) {
    throw new PilotError(`Правила должны быть файлом: ${absolute}`, { exitCode: 2 });
  }

  const display = relative(cwd, absolute).replace(/\\/g, "/") || absolute;
  let content: string;
  try {
    content = readFileSync(absolute, "utf8").replace(/^\uFEFF/, "");
  } catch (error) {
    throw new PilotError(`Не удалось прочитать правила: ${absolute}`, {
      hint: error instanceof Error ? error.message : String(error),
      exitCode: 2,
    });
  }

  const truncated = truncateText(content, MAX_RULES_CHARS, { mode: "head" });
  const scan = scanText(truncated.text, display, { ignore: loadSecretIgnore(cwd) });
  return {
    path: display,
    text: scan.redacted,
    rawText: truncated.text,
    findings: scan.findings,
    truncated: truncated.truncated,
  };
}

export { DEFAULT_RULES_PATH, MAX_RULES_CHARS };
