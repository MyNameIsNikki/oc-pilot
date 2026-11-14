import { extname } from "node:path";
import type { DeadExport, SourceFile } from "./model.js";
import { isCodeFile, isGeneratedPath, isTestFile } from "./source.js";

const MAX_DECLARATIONS_PER_FILE = 500;
const MAX_DEAD = 2_000;

const ENTRY_FILE =
  /(^|\/)(index|main|cli|mcp|setup|vite\.config|next\.config)\.[cm]?[jt]sx?$|(^|\/)(bin|scripts|cmd)\//;

interface Declaration {
  name: string;
  line: number;
  kind: string;
}

const JS_DECL =
  /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;
const JS_EXPORT_LIST = /^\s*export\s*(?:type\s*)?\{([^}]*)\}/;
const GO_DECL = /^(?:func|type|var|const)\s+([A-Z]\w*)/;
const PY_DECL = /^(?:async\s+def|def|class)\s+([A-Za-z]\w*)/;

function declarationsOf(file: SourceFile): Declaration[] {
  const extension = extname(file.path).toLowerCase();
  const found: Declaration[] = [];

  file.text.split("\n").forEach((line, index) => {
    const at = index + 1;
    if (found.length >= MAX_DECLARATIONS_PER_FILE) return;

    if (extension === ".go") {
      const match = GO_DECL.exec(line);
      if (match) found.push({ name: match[1]!, line: at, kind: "symbol" });
      return;
    }
    if (extension === ".py") {
      const match = PY_DECL.exec(line);
      if (match && !match[1]!.startsWith("_")) {
        found.push({ name: match[1]!, line: at, kind: line.trimStart().startsWith("class") ? "class" : "function" });
      }
      return;
    }

    const direct = JS_DECL.exec(line);
    if (direct) {
      // Type-only exports never ship and are routinely used only inside their
      // own module, so reporting them as dead code would be pure noise.
      if (direct[1] === "interface" || direct[1] === "type") return;
      found.push({ name: direct[2]!, line: at, kind: direct[1]! });
      return;
    }
    if (/^\s*export\s+type\s*\{/.test(line)) return;
    const list = JS_EXPORT_LIST.exec(line);
    if (list) {
      for (const specifier of list[1]!.split(",")) {
        const parts = specifier.trim().replace(/^type\s+/, "").split(/\s+as\s+/);
        const name = (parts[1] ?? parts[0] ?? "").trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name) && name !== "default") {
          found.push({ name, line: at, kind: "export" });
        }
      }
    }
  });

  return found;
}

function identifierCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(/[A-Za-z_$][\w$]*/g)) {
    counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
  }
  return counts;
}

function ignoredFile(path: string): boolean {
  return isTestFile(path) || isGeneratedPath(path) || ENTRY_FILE.test(path) || !isCodeFile(path);
}

/**
 * An export is dead when its name appears only in its own declaration: no
 * other file mentions it and its own module never uses it. The check is
 * intentionally textual: dynamic access through strings counts as a reference
 * when the name appears somewhere else.
 */
export function findDeadExports(allFiles: SourceFile[], maxDead = 500): DeadExport[] {
  if (allFiles.length < 2) return [];

  const corpus = allFiles.map((file) => ({
    path: file.path.replace(/\\/g, "/"),
    text: file.text,
    counts: identifierCounts(file.text),
  }));
  const dead: DeadExport[] = [];

  for (const entry of corpus) {
    if (ignoredFile(entry.path)) continue;

    for (const declaration of declarationsOf({ path: entry.path, text: entry.text })) {
      if (declaration.name.length <= 2 || declaration.name.startsWith("_")) continue;
      const referenced =
        (entry.counts.get(declaration.name) ?? 0) > 1 ||
        corpus.some((other) => other.path !== entry.path && other.counts.has(declaration.name));
      if (referenced) continue;
      dead.push({
        file: entry.path,
        line: declaration.line,
        name: declaration.name,
        kind: declaration.kind,
      });
      if (dead.length >= MAX_DEAD) break;
    }
    if (dead.length >= MAX_DEAD) break;
  }

  dead.sort((x, y) => x.file.localeCompare(y.file) || x.line - y.line);
  return dead.slice(0, maxDead);
}
