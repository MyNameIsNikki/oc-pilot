import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { analyzeImpact } from "./impact.js";
import { loadRules } from "./rules.js";
import { isCodeFile, isGeneratedPath, isTestFile } from "./slop/source.js";

export interface PackOptions {
  task: string;
  diff: string;
  changedFiles: string[];
  budget?: number;
  rulesPath?: string;
  testLog?: string;
}

export interface PackFile {
  file: string;
  role: "changed" | "related" | "test";
  chars: number;
  truncated: boolean;
}

export interface PackSection {
  title: string;
  chars: number;
  items: number;
}

export interface PackReport {
  task: string;
  budget: number;
  chars: number;
  truncated: boolean;
  sections: PackSection[];
  files: PackFile[];
  content: string;
}

const DEFAULT_BUDGET = 20_000;
const MAX_FILE_BYTES = 256_000;
const MAX_RULES_CHARS = 4_000;
const MAX_TASK_CHARS = 2_000;
const MAX_TEST_LOG_CHARS = 3_000;
const MAX_RELATED_FILES = 8;

const TEST_NAME = /\b(?:it|test|describe)\s*\(\s*["'`]([^"'`]+)["'`]/g;

function readText(cwd: string, file: string): string | undefined {
  try {
    const path = join(cwd, file);
    if (!existsSync(path) || statSync(path).size > MAX_FILE_BYTES) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Keeps imports and declaration lines while dropping bodies. This is a
 * deliberately small line-based extractor: it has no AST dependency and is
 * good enough to show an agent the shape of a file without its implementation.
 */
export function extractSignatures(text: string): string[] {
  const out: string[] = [];
  let inBlockComment = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (inBlockComment) {
      if (trimmed.includes("*/")) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) inBlockComment = true;
      continue;
    }
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    if (/^(?:import|export)\b/.test(trimmed)) {
      out.push(line);
      continue;
    }
    if (/^(?:async\s+)?(?:function|class|interface|type|enum)\s+[A-Za-z_$]/.test(trimmed)) {
      out.push(line);
      continue;
    }
    if (/^(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=/.test(trimmed)) {
      out.push(line);
      continue;
    }
    if (
      /^ {2}(?:public |private |protected |static |async |readonly |get |set )*[A-Za-z_$][\w$]*\s*\([^)]*\)\s*(?::[^{]+)?\{?\s*$/.test(
        line,
      )
    ) {
      out.push(line);
    }
  }

  return out;
}

export function extractTestNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(TEST_NAME)) {
    const name = match[1]?.trim();
    if (name) names.add(name);
  }
  return [...names];
}

function fileBlock(file: string, body: string): string {
  return `### ${file}\n\n\`\`\`\n${body.trim()}\n\`\`\`\n`;
}

function signatureBody(cwd: string, file: string): { body: string; chars: number; truncated: boolean } | undefined {
  const text = readText(cwd, file);
  if (text === undefined) return undefined;
  const signatures = isTestFile(file) ? [] : extractSignatures(text);
  const body = signatures.length > 0 ? signatures.join("\n") : "// объявления не найдены";
  return { body: fileBlock(file, body), chars: text.length, truncated: false };
}

function testBody(cwd: string, file: string): { body: string; chars: number; truncated: boolean } | undefined {
  const text = readText(cwd, file);
  if (text === undefined) return undefined;
  const names = extractTestNames(text);
  const body = names.length > 0 ? names.map((name) => `- ${name}`).join("\n") : "// тесты не найдены";
  return { body: fileBlock(file, body), chars: text.length, truncated: false };
}

function relatedFiles(diff: string, changedFiles: string[], cwd: string): string[] {
  try {
    const impact = analyzeImpact(cwd, diff, changedFiles);
    const counts = new Map<string, number>();
    for (const reference of impact.references) {
      if (changedFiles.includes(reference.file)) continue;
      if (isGeneratedPath(reference.file)) continue;
      counts.set(reference.file, (counts.get(reference.file) ?? 0) + 1);
    }
    return [...counts]
      .sort(([leftFile, leftCount], [rightFile, rightCount]) => rightCount - leftCount || leftFile.localeCompare(rightFile))
      .map(([file]) => file)
      .slice(0, MAX_RELATED_FILES);
  } catch {
    return [];
  }
}

function truncateBody(body: string, limit: number): string {
  if (body.length <= limit) return body;
  const cut = body.slice(0, Math.max(0, limit - 4));
  const newline = cut.lastIndexOf("\n");
  return `${newline > 0 ? cut.slice(0, newline) : cut}\n…\n`;
}

export function buildPack(cwd: string, options: PackOptions): PackReport {
  const budget = Math.max(200, options.budget ?? DEFAULT_BUDGET);
  const parts: string[] = ["# Context pack\n\n"];
  const sections: PackSection[] = [];
  const files: PackFile[] = [];
  let truncated = false;

  const append = (title: string, body: string, items: number): boolean => {
    const section = `## ${title}\n\n${body.trim()}\n\n`;
    const current = parts.join("");
    const remaining = budget - current.length;
    if (remaining <= 0) {
      truncated = true;
      return false;
    }
    if (section.length <= remaining) {
      parts.push(section);
      sections.push({ title, chars: section.length, items });
      return true;
    }
    const header = `## ${title}\n\n`;
    if (remaining <= header.length + 8) {
      truncated = true;
      return false;
    }
    const clipped = truncateBody(body.trim(), remaining - header.length - 4);
    const clippedSection = `${header}${clipped}\n\n`;
    parts.push(clippedSection);
    sections.push({ title, chars: clippedSection.length, items });
    truncated = true;
    return false;
  };

  const task = options.task.trim().slice(0, MAX_TASK_CHARS);
  append("Задача", task || "Задача не указана.", 1);

  const rules = loadRules(cwd, options.rulesPath);
  if (rules?.text.trim()) {
    append("Правила проекта", rules.text.trim().slice(0, MAX_RULES_CHARS), 1);
  }

  const changed = options.changedFiles.filter(
    (file) => isCodeFile(file) && !isGeneratedPath(file) && !isTestFile(file),
  );
  const changedBodies = changed
    .map((file) => ({ file, body: signatureBody(cwd, file) }))
    .filter((item): item is { file: string; body: { body: string; chars: number; truncated: boolean } } => item.body !== undefined);

  if (changedBodies.length > 0) {
    const body = changedBodies.map((item) => item.body.body).join("\n");
    append("Изменённые файлы", body, changedBodies.length);
    for (const item of changedBodies) {
      files.push({ file: item.file, role: "changed", chars: item.body.chars, truncated: false });
    }
  }

  const related = relatedFiles(options.diff, options.changedFiles, cwd);
  const relatedBodies = related
    .map((file) => ({ file, body: isTestFile(file) ? testBody(cwd, file) : signatureBody(cwd, file) }))
    .filter((item): item is { file: string; body: { body: string; chars: number; truncated: boolean } } => item.body !== undefined);

  if (relatedBodies.length > 0) {
    const body = relatedBodies.map((item) => item.body.body).join("\n");
    append("Связанные файлы", body, relatedBodies.length);
    for (const item of relatedBodies) {
      files.push({
        file: item.file,
        role: isTestFile(item.file) ? "test" : "related",
        chars: item.body.chars,
        truncated: false,
      });
    }
  }

  const changedTests = options.changedFiles.filter((file) => isTestFile(file) && !isGeneratedPath(file));
  const testBodies = changedTests
    .map((file) => ({ file, body: testBody(cwd, file) }))
    .filter((item): item is { file: string; body: { body: string; chars: number; truncated: boolean } } => item.body !== undefined);

  if (testBodies.length > 0) {
    const body = testBodies.map((item) => item.body.body).join("\n");
    append("Тесты", body, testBodies.length);
    for (const item of testBodies) {
      files.push({ file: item.file, role: "test", chars: item.body.chars, truncated: false });
    }
  }

  const testLog = options.testLog?.trim();
  if (testLog) {
    append("Последнее падение тестов", testLog.slice(-MAX_TEST_LOG_CHARS), 1);
  }

  const content = parts.join("");
  return {
    task,
    budget,
    chars: content.length,
    truncated: truncated || content.length > budget,
    sections,
    files,
    content,
  };
}
