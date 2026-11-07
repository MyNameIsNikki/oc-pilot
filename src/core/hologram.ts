import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { PilotError } from "./errors.js";
import { buildImportGraph } from "./import-graph.js";
import { scanText } from "./secrets.js";
import { readRepository } from "./slop/collect.js";
import { isCodeFile, isGeneratedPath, isTestFile } from "./slop/source.js";

export type HologramLod = 0 | 1 | 2;
export type HologramSymbolKind = "function" | "class" | "arrow";

export interface HologramFile {
  file: string;
  lod: HologramLod;
  chars: number;
  bailout: boolean;
  effects: string[];
}

export interface HologramZoomEntry {
  file: string;
  symbol: string;
}

export interface HologramOptions {
  task?: string;
  diff: string;
  changedFiles: string[];
  maxTokens?: number;
}

export interface HologramReport {
  task: string;
  maxTokens: number;
  chars: number;
  estimatedTokens: number;
  truncated: boolean;
  files: HologramFile[];
  zoom: HologramZoomEntry[];
  secretFindings: number;
  content: string;
}

export interface ZoomResult {
  file: string;
  symbol: string;
  kind: HologramSymbolKind;
  line: number;
  body: string;
}

interface SymbolBlock {
  name: string;
  kind: HologramSymbolKind;
  headerStart: number;
  bodyStart: number;
  bodyEnd: number;
}

interface CutResult {
  text: string;
  bailout: boolean;
  effects: string[];
}

const DEFAULT_MAX_TOKENS = 30_000;
const CHARS_PER_TOKEN = 4;
const MAX_FILE_BYTES = 256_000;
const MAX_ZOOM_ENTRIES = 400;
const MAX_LOD2_FILES = 400;

const FUNCTION_LINE = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;
const CLASS_LINE = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/;
const ARROW_LINE = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/;
const FUNCTION_EXPRESSION_LINE = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?function\b/;
const EXPORT_DECLARATION = /^export\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/;
const EXPORT_LIST = /^export\s+(?:type\s+)?\{([^}]+)\}/;
const EXPORT_DEFAULT = /^export\s+default\s+([A-Za-z_$][\w$]*)\s*;?$/;
const TEST_TITLE = /\b(?:it|test|describe)\s*\(\s*["'`]([^"'`]*)/g;

const EFFECT_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "fetch", pattern: /\bfetch\s*\(|\baxios\b|\bXMLHttpRequest\b|\bhttps?\.(?:get|request)\b/ },
  { name: "db", pattern: /\b(?:db|prisma|knex|sequelize|mongoose|client)\.(?:query|execute|find|insert|update|delete)\b|\bquery\s*\(/ },
  { name: "fs", pattern: /\b(?:readFile|writeFile|appendFile|unlink|mkdir|rm|createReadStream|createWriteStream)(?:Sync)?\s*\(|\bfs\./ },
  { name: "exec", pattern: /\b(?:exec|execSync|spawn|spawnSync|fork)\s*\(|\bchild_process\b/ },
  { name: "env", pattern: /\bprocess\.env\b/ },
  { name: "net", pattern: /\bnet\.|\bhttp\.|\bhttps\.|\bWebSocket\b/ },
];

function readSource(cwd: string, file: string): string | undefined {
  const path = resolve(cwd, file);
  if (!existsSync(path)) return undefined;
  try {
    if (statSync(path).size > MAX_FILE_BYTES) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Brace matcher that ignores strings and comments. Returns -1 on a broken block. */
function matchBrace(text: string, openIndex: number): number {
  let depth = 0;
  let index = openIndex;
  while (index < text.length) {
    const char = text[index]!;
    const next = text[index + 1];
    if (char === '"' || char === "'" || char === "`") {
      index += 1;
      while (index < text.length) {
        const inner = text[index]!;
        if (inner === "\\") {
          index += 2;
          continue;
        }
        index += 1;
        if (inner === char) break;
      }
      continue;
    }
    if (char === "/" && next === "/") {
      const lineEnd = text.indexOf("\n", index);
      index = lineEnd < 0 ? text.length : lineEnd + 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const close = text.indexOf("*/", index + 2);
      index = close < 0 ? text.length : close + 2;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return -1;
}

function braceBalance(text: string): number {
  let balance = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    const next = text[index + 1];
    if (char === '"' || char === "'" || char === "`") {
      index += 1;
      while (index < text.length) {
        const inner = text[index]!;
        if (inner === "\\") {
          index += 2;
          continue;
        }
        index += 1;
        if (inner === char) break;
      }
      continue;
    }
    if (char === "/" && next === "/") {
      const lineEnd = text.indexOf("\n", index);
      index = lineEnd < 0 ? text.length : lineEnd + 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const close = text.indexOf("*/", index + 2);
      index = close < 0 ? text.length : close + 2;
      continue;
    }
    if (char === "{") balance += 1;
    else if (char === "}") balance -= 1;
    index += 1;
  }
  return balance;
}

function findSymbols(text: string): { symbols: SymbolBlock[]; broken: boolean } {
  const symbols: SymbolBlock[] = [];
  const lines = text.split("\n");
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }

  let inBlockComment = false;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    const trimmed = line.trim();
    if (inBlockComment) {
      if (trimmed.includes("*/")) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) inBlockComment = true;
      continue;
    }
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    if (line.length !== line.trimStart().length) continue;

    let name: string | undefined;
    let kind: HologramSymbolKind | undefined;
    if (FUNCTION_LINE.test(line)) {
      name = FUNCTION_LINE.exec(line)?.[1];
      kind = "function";
    } else if (CLASS_LINE.test(line)) {
      name = CLASS_LINE.exec(line)?.[1];
      kind = "class";
    } else if (ARROW_LINE.test(line)) {
      name = ARROW_LINE.exec(line)?.[1];
      kind = "arrow";
    } else if (FUNCTION_EXPRESSION_LINE.test(line)) {
      name = FUNCTION_EXPRESSION_LINE.exec(line)?.[1];
      kind = "function";
    }
    if (!name || !kind) continue;

    const lineOffset = offsets[lineIndex]!;
    const open = text.indexOf("{", lineOffset);
    if (open < 0 || open - lineOffset > 4000) continue;
    const bodyEnd = matchBrace(text, open);
    if (bodyEnd < 0) return { symbols, broken: true };
    symbols.push({ name, kind, headerStart: lineOffset, bodyStart: open, bodyEnd });
  }
  return { symbols, broken: false };
}

function effectsOf(body: string): string[] {
  const found = new Set<string>();
  for (const effect of EFFECT_PATTERNS) {
    if (effect.pattern.test(body)) found.add(effect.name);
  }
  return [...found].sort();
}

function cutFile(text: string): CutResult {
  const { symbols, broken } = findSymbols(text);
  if (broken) return { text, bailout: true, effects: [] };
  if (braceBalance(text) !== 0) return { text, bailout: true, effects: [] };

  const cuttable = symbols
    .filter((symbol) => symbol.kind !== "class" && symbol.bodyEnd > symbol.bodyStart)
    .sort((left, right) => right.bodyStart - left.bodyStart);
  if (cuttable.length === 0) return { text, bailout: false, effects: [] };

  let output = text;
  const effects = new Set<string>();
  for (const symbol of cuttable) {
    const body = output.slice(symbol.bodyStart + 1, symbol.bodyEnd);
    if (!body.trim()) continue;
    const symbolEffects = effectsOf(body);
    for (const effect of symbolEffects) effects.add(effect);
    const marker =
      "/* oc-pilot: body hidden (LOD 1) */" +
      (symbolEffects.length > 0 ? ` /* oc-pilot: EFFECTS(${symbolEffects.join(", ")}) */` : "");
    output = output.slice(0, symbol.bodyStart + 1) + ` ${marker} ` + output.slice(symbol.bodyEnd);
  }

  if (braceBalance(output) !== 0) return { text, bailout: true, effects: [] };
  return { text: output, bailout: false, effects: [...effects].sort() };
}

/** Export names in source order, without duplicates. */
export function exportNames(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (value: string): void => {
    const name = value.trim().split(/\s+as\s+/).pop()?.trim() ?? "";
    if (!/^[A-Za-z_$][\w$]*$/.test(name) || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };
  for (const line of text.split("\n")) {
    const declaration = EXPORT_DECLARATION.exec(line);
    if (declaration?.[1]) {
      add(declaration[1]);
      continue;
    }
    const list = EXPORT_LIST.exec(line);
    if (list?.[1]) {
      for (const part of list[1].split(",")) add(part);
      continue;
    }
    const single = EXPORT_DEFAULT.exec(line);
    if (single?.[1]) add(single[1]);
  }
  return names;
}

function testSnippets(cwd: string, file: string, symbol: string): string[] {
  const extension = extname(file);
  const base = basename(file, extension);
  const dir = dirname(file);
  const candidates = [
    `${dir}/${base}.test${extension}`,
    `${dir}/${base}.spec${extension}`,
    `${dir}/__tests__/${base}.test${extension}`,
    `${dir}/__tests__/${base}.spec${extension}`,
    `${dir}/${base}.test.ts`,
    `${dir}/${base}.test.js`,
  ];
  const snippets: string[] = [];
  const needle = symbol.toLowerCase();
  for (const candidate of new Set(candidates)) {
    const text = readSource(cwd, candidate);
    if (!text) continue;
    for (const match of text.matchAll(TEST_TITLE)) {
      const title = match[1] ?? "";
      if (!title.toLowerCase().includes(needle)) continue;
      const open = text.indexOf("{", match.index ?? 0);
      if (open < 0) continue;
      const close = matchBrace(text, open);
      if (close < 0) continue;
      const start = text.lastIndexOf("\n", match.index ?? 0) + 1;
      const snippet = text.slice(start, close + 1).trim();
      if (snippet.length > 0 && !snippets.includes(snippet)) snippets.push(snippet);
      if (snippets.length >= 2) return snippets.map((value) => (value.length > 1200 ? `${value.slice(0, 1200)}\n…` : value));
    }
  }
  return snippets.map((value) => (value.length > 1200 ? `${value.slice(0, 1200)}\n…` : value));
}

function languageOf(file: string): string {
  const extension = extname(file).slice(1);
  return /^[a-z]+$/.test(extension) ? extension : "";
}

function fileBlock(file: string, body: string): string {
  return `### ${file}\n\n\`\`\`${languageOf(file)}\n${body.trim()}\n\`\`\`\n`;
}

function lod2Body(text: string): string {
  const names = exportNames(text);
  if (names.length === 0) return "// экспортов не найдено";
  return `// LOD 2: только имена экспортов\n${names.map((name) => `- ${name}`).join("\n")}`;
}

function isSourceFile(file: string): boolean {
  return isCodeFile(file) && !isGeneratedPath(file) && !isTestFile(file);
}

/** Builds a layered semantic hologram: full diff files, cut direct imports, export-only rest. */
export function buildHologram(cwd: string, options: HologramOptions): HologramReport {
  const task = options.task?.trim() || "Контекст репозитория для агента";
  const maxTokens = Math.max(1000, Math.min(200_000, Math.round(options.maxTokens ?? DEFAULT_MAX_TOKENS)));
  const charBudget = maxTokens * CHARS_PER_TOKEN;
  const changed = new Set(options.changedFiles.filter((file) => isSourceFile(file)));
  const repository = readRepository(cwd).files;
  const known = new Set(repository.map((file) => file.path));

  const graph = buildImportGraph(cwd, repository);
  const lod1 = new Set<string>();
  for (const edge of graph.edges) {
    if (changed.has(edge.from) && !changed.has(edge.to) && isSourceFile(edge.to)) lod1.add(edge.to);
    if (changed.has(edge.to) && !changed.has(edge.from) && isSourceFile(edge.from)) lod1.add(edge.from);
  }

  const lod2 = repository
    .map((file) => file.path)
    .filter((file) => isSourceFile(file) && !changed.has(file) && !lod1.has(file))
    .sort()
    .slice(0, MAX_LOD2_FILES);

  interface Entry {
    file: string;
    lod: HologramLod;
    body: string;
    bailout: boolean;
    effects: string[];
    chars: number;
  }
  const entries: Entry[] = [];
  const zoom: HologramZoomEntry[] = [];

  for (const file of [...changed].sort()) {
    const text = readSource(cwd, file);
    if (text === undefined) continue;
    entries.push({ file, lod: 0, body: fileBlock(file, text), bailout: false, effects: [], chars: text.length });
    for (const symbol of findSymbols(text).symbols) {
      if (zoom.length < MAX_ZOOM_ENTRIES) zoom.push({ file, symbol: symbol.name });
    }
  }

  for (const file of [...lod1].sort()) {
    if (!known.has(file)) continue;
    const text = readSource(cwd, file);
    if (text === undefined) continue;
    const cut = cutFile(text);
    let body = fileBlock(file, cut.text);
    if (cut.bailout) body = `[Hologram: parse bailout]\n\n${body}`;
    for (const symbol of findSymbols(text).symbols) {
      const snippets = testSnippets(cwd, file, symbol.name);
      for (const snippet of snippets) {
        body += `\n#### Тесты: ${symbol.name}\n\n\`\`\`${languageOf(file)}\n${snippet}\n\`\`\`\n`;
      }
      if (zoom.length < MAX_ZOOM_ENTRIES) zoom.push({ file, symbol: symbol.name });
    }
    entries.push({ file, lod: 1, body, bailout: cut.bailout, effects: cut.effects, chars: body.length });
  }

  for (const file of lod2) {
    const text = readSource(cwd, file);
    if (text === undefined) continue;
    const names = exportNames(text);
    if (names.length === 0) continue;
    const body = fileBlock(file, lod2Body(text));
    entries.push({ file, lod: 2, body, bailout: false, effects: [], chars: body.length });
    for (const name of names) {
      if (zoom.length < MAX_ZOOM_ENTRIES) zoom.push({ file, symbol: name });
    }
  }

  const header = [
    "# Context hologram",
    "",
    `Задача: ${task}`,
    `Бюджет: ~${String(maxTokens)} токенов (${String(charBudget)} символов)`,
    "",
    "LOD 0 — файлы из diff, полный текст. LOD 1 — прямые импорты, тела функций скрыты.",
    "LOD 2 — остальные файлы, только имена экспортов.",
    "",
  ].join("\n");

  const sections: string[] = [header];
  let chars = header.length;
  let truncated = false;
  const files: HologramFile[] = [];
  const titles: Record<HologramLod, string> = {
    0: "## LOD 0: изменённые файлы (полный текст)",
    1: "## LOD 1: прямые импорты (тела скрыты)",
    2: "## LOD 2: остальные файлы (только экспорты)",
  };

  for (const lod of [0, 1, 2] as const) {
    const group = entries.filter((entry) => entry.lod === lod);
    if (group.length === 0) continue;
    const title = `${titles[lod]}\n\n`;
    sections.push(title);
    chars += title.length;
    for (const entry of group) {
      if (lod > 0 && chars + entry.body.length > charBudget) {
        truncated = true;
        continue;
      }
      sections.push(entry.body);
      chars += entry.body.length;
      files.push({
        file: entry.file,
        lod: entry.lod,
        chars: entry.chars,
        bailout: entry.bailout,
        effects: entry.effects,
      });
    }
  }

  const zoomLines = [
    "## Zoom",
    "",
    "Bodies are hidden. If you need the implementation, call zoom_symbol(filePath, symbolName).",
    "",
    ...zoom.map((entry) => `- ${entry.file}: ${entry.symbol}`),
    "",
  ];
  sections.push(zoomLines.join("\n"));
  chars += zoomLines.join("\n").length;

  const scanned = scanText(sections.join("\n"), "context.md");
  const content = scanned.redacted;
  return {
    task,
    maxTokens,
    chars: content.length,
    estimatedTokens: Math.ceil(content.length / CHARS_PER_TOKEN),
    truncated: truncated || content.length > charBudget,
    files,
    zoom,
    secretFindings: scanned.findings.length,
    content,
  };
}

function assertInside(cwd: string, file: string): string {
  const root = resolve(cwd);
  const target = resolve(root, file);
  const rel = relative(root, target);
  if (rel.startsWith("..") || rel.includes(`..${sep}`) || resolve(root, rel) !== target) {
    throw new PilotError("Путь выходит за пределы проекта", { exitCode: 2 });
  }
  return target;
}

/** Returns the full body of one symbol on demand, the escape hatch for LOD 1. */
export function zoomSymbol(cwd: string, file: string, symbol: string): ZoomResult {
  const target = assertInside(cwd, file);
  if (!existsSync(target)) {
    throw new PilotError(`Файл не найден: ${file}`, { exitCode: 2 });
  }
  if (statSync(target).size > MAX_FILE_BYTES) {
    throw new PilotError(`Файл больше ${String(MAX_FILE_BYTES)} байт: ${file}`, { exitCode: 2 });
  }
  const text = readFileSync(target, "utf8");
  const { symbols } = findSymbols(text);
  const found = symbols.find((entry) => entry.name === symbol);
  if (!found) {
    throw new PilotError(`Символ не найден: ${symbol} в ${file}`, {
      hint: "Используйте имя из секции Zoom в контексте.",
      exitCode: 2,
    });
  }
  const line = text.slice(0, found.headerStart).split("\n").length;
  const body = text.slice(found.headerStart, found.bodyEnd + 1);
  return { file, symbol, kind: found.kind, line, body };
}
