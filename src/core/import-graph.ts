import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { readRepository } from "./slop/collect.js";
import type { SourceFile } from "./slop/model.js";

export interface ImportEdge {
  from: string;
  to: string;
  specifier: string;
  line: number;
}

export interface ImportGraph {
  files: string[];
  edges: ImportEdge[];
  reverse: Map<string, string[]>;
}

interface ImportAlias {
  prefix: string;
  targets: string[];
  baseUrl: string;
}

const IMPORT_PATTERNS = [
  /^\s*import\s+(?:type\s+)?(?:[^"']+?\s+from\s+)?["']([^"']+)["']/,
  /^\s*export\s+(?:type\s+)?[^"']*?\s+from\s+["']([^"']+)["']/,
  /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
];

const PY_FROM = /^\s*from\s+(\.[\w.]*)\s+import\s+/;

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py"];

function normalizePath(value: string): string {
  return normalize(value).replace(/\\/g, "/").replace(/^\.\//, "");
}

function readAliases(cwd: string): ImportAlias[] {
  const file = join(cwd, "tsconfig.json");
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as {
      compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
    };
    const options = parsed.compilerOptions;
    if (!options?.paths) return [];
    const baseUrl = options.baseUrl ?? ".";
    const aliases: ImportAlias[] = [];
    for (const [pattern, targets] of Object.entries(options.paths)) {
      if (!Array.isArray(targets) || targets.length === 0) continue;
      const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
      aliases.push({ prefix, targets: targets.filter((target) => typeof target === "string"), baseUrl });
    }
    return aliases;
  } catch {
    return [];
  }
}

function aliasCandidates(specifier: string, aliases: ImportAlias[]): string[] {
  const out: string[] = [];
  for (const alias of aliases) {
    if (alias.prefix && !specifier.startsWith(alias.prefix)) continue;
    const rest = specifier.slice(alias.prefix.length);
    for (const target of alias.targets) {
      const replaced = target.includes("*") ? target.split("*").join(rest) : target;
      out.push(normalizePath(join(alias.baseUrl, replaced)));
    }
  }
  return out;
}

function fileCandidates(base: string, files: Set<string>): string | undefined {
  const normalized = normalizePath(base);
  if (files.has(normalized)) return normalized;
  for (const extension of EXTENSIONS) {
    if (files.has(`${normalized}${extension}`)) return `${normalized}${extension}`;
  }
  if (normalized.endsWith(".js")) {
    const stem = normalized.slice(0, -3);
    for (const extension of [".ts", ".tsx", ".mts", ".cts"]) {
      if (files.has(`${stem}${extension}`)) return `${stem}${extension}`;
    }
  }
  for (const extension of EXTENSIONS) {
    const index = `${normalized}/index${extension}`;
    if (files.has(index)) return index;
  }
  return undefined;
}

/** Resolves a specifier to a repository file when it is an internal import. */
export function resolveSpecifier(
  file: string,
  specifier: string,
  files: Set<string>,
  aliases: ImportAlias[] = [],
): string | undefined {
  if (!specifier) return undefined;
  if (specifier.startsWith("@/")) {
    return fileCandidates(`src/${specifier.slice(2)}`, files);
  }
  if (specifier.startsWith(".")) {
    const base = normalizePath(join(dirname(file), specifier));
    return fileCandidates(base, files);
  }
  for (const candidate of aliasCandidates(specifier, aliases)) {
    const resolved = fileCandidates(candidate, files);
    if (resolved) return resolved;
  }
  return undefined;
}

/** Extracts static imports from one source file with their line numbers. */
export function parseImports(_file: string, text: string): Array<{ specifier: string; line: number }> {
  const imports: Array<{ specifier: string; line: number }> = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    let matched = false;
    for (const pattern of IMPORT_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        if (match[1]) {
          imports.push({ specifier: match[1], line: index + 1 });
          matched = true;
        }
        if (!pattern.global) break;
      }
    }
    if (matched) continue;
    const python = PY_FROM.exec(line);
    if (python?.[1] && python[1] !== ".") {
      const dots = /^\.+/.exec(python[1])?.[0].length ?? 0;
      const rest = python[1].slice(dots).replace(/\./g, "/");
      const prefix = dots <= 1 ? "./" : "../".repeat(dots - 1);
      imports.push({ specifier: `${prefix}${rest}`, line: index + 1 });
    }
  }
  return imports;
}

/** Builds the internal import graph for a repository. */
export function buildImportGraph(cwd: string, sourceFiles?: SourceFile[]): ImportGraph {
  const files = sourceFiles ?? readRepository(cwd).files;
  const paths = new Set(files.map((file) => file.path));
  const aliases = readAliases(cwd);
  const edges: ImportEdge[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    for (const use of parseImports(file.path, file.text)) {
      const resolved = resolveSpecifier(file.path, use.specifier, paths, aliases);
      if (!resolved) continue;
      const key = `${file.path}:${String(use.line)}:${resolved}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: file.path, to: resolved, specifier: use.specifier, line: use.line });
    }
  }
  const reverse = new Map<string, string[]>();
  for (const edge of edges) {
    const list = reverse.get(edge.to) ?? [];
    if (!list.includes(edge.from)) list.push(edge.from);
    reverse.set(edge.to, list);
  }
  return { files: [...paths].sort(), edges, reverse };
}

/** Resolves one specifier from a file, including tsconfig aliases. */
export function resolveImportSpecifier(
  cwd: string,
  file: string,
  specifier: string,
  files?: Set<string>,
): string | undefined {
  const paths = files ?? new Set(readRepository(cwd).files.map((entry) => entry.path));
  return resolveSpecifier(file, specifier, paths, readAliases(cwd));
}

/** All files that transitively import one of the changed files. */
export function reverseClosure(graph: ImportGraph, changed: Iterable<string>): Set<string> {
  const result = new Set<string>();
  const queue = [...changed];
  while (queue.length > 0) {
    const file = queue.pop()!;
    for (const dependent of graph.reverse.get(file) ?? []) {
      if (result.has(dependent)) continue;
      result.add(dependent);
      queue.push(dependent);
    }
  }
  return result;
}
