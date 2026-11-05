import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runShellCommand } from "./command.js";
import { PilotError } from "./errors.js";

export type MutationStatus = "killed" | "survived" | "timeout";

export interface MutationSite {
  file: string;
  line: number;
  column: number;
  operator: string;
  original: string;
  replacement: string;
  start: number;
  end: number;
}

export interface MutantResult {
  file: string;
  line: number;
  column: number;
  operator: string;
  original: string;
  replacement: string;
  status: MutationStatus;
  durationMs: number;
}

export interface MutationReport {
  command: string;
  files: string[];
  sites: number;
  mutants: MutantResult[];
  killed: number;
  survived: number;
  timedOut: number;
  score: number | null;
  truncated: boolean;
  durationMs: number;
}

export interface RunMutationOptions {
  command: string;
  maxMutants?: number;
  timeoutMs?: number;
  onProgress?: (result: MutantResult, index: number, total: number) => void;
}

const OPERATORS = /===|!==|==|!=|>=|<=|&&|\|\||\btrue\b|\bfalse\b/g;

const REPLACEMENTS: Record<string, string> = {
  "===": "!==",
  "!==": "===",
  "==": "!=",
  "!=": "==",
  ">=": "<",
  "<=": ">",
  "&&": "||",
  "||": "&&",
  true: "false",
  false: "true",
};

/**
 * Blanks comments, strings and template literals while keeping the original
 * offsets, so a mutation never lands inside a string or a comment.
 */
export function maskNonCode(text: string): string {
  const out = text.split("");
  const blank = (from: number, to: number): void => {
    for (let index = from; index < to; index += 1) {
      if (out[index] !== "\n" && out[index] !== "\r") out[index] = " ";
    }
  };

  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];

    if (char === "/" && next === "/") {
      const start = index;
      index += 2;
      while (index < text.length && text[index] !== "\n") index += 1;
      blank(start, index);
      continue;
    }

    if (char === "/" && next === "*") {
      const start = index;
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index = Math.min(text.length, index + 2);
      blank(start, index);
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      const start = index;
      index += 1;
      while (index < text.length) {
        if (text[index] === "\\") {
          index += 2;
          continue;
        }
        if (text[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      blank(start, index);
      continue;
    }

    index += 1;
  }

  return out.join("");
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function positionAt(starts: number[], offset: number): { line: number; column: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return { line: low + 1, column: offset - starts[low]! + 1 };
}

export function listMutationSites(file: string, text: string): MutationSite[] {
  const masked = maskNonCode(text);
  const starts = lineStarts(text);
  const sites: MutationSite[] = [];

  for (const match of masked.matchAll(OPERATORS)) {
    const original = match[0];
    const replacement = REPLACEMENTS[original];
    if (replacement === undefined || match.index === undefined) continue;
    const position = positionAt(starts, match.index);
    sites.push({
      file,
      line: position.line,
      column: position.column,
      operator: original,
      original,
      replacement,
      start: match.index,
      end: match.index + original.length,
    });
  }

  return sites;
}

export function applyMutation(text: string, site: MutationSite): string {
  return `${text.slice(0, site.start)}${site.replacement}${text.slice(site.end)}`;
}

export async function runMutation(
  cwd: string,
  files: Array<{ path: string; text: string }>,
  options: RunMutationOptions,
): Promise<MutationReport> {
  const started = Date.now();
  const allSites = files
    .flatMap((file) => listMutationSites(file.path, file.text))
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column);

  const maxMutants = Math.max(1, options.maxMutants ?? 20);
  const selected = allSites.slice(0, maxMutants);
  const sources = new Map(files.map((file) => [file.path, file.text]));
  const mutants: MutantResult[] = [];

  for (const [index, site] of selected.entries()) {
    const original = sources.get(site.file);
    if (original === undefined) continue;
    const absolute = join(cwd, site.file);
    const mutantStarted = Date.now();

    writeFileSync(absolute, applyMutation(original, site), "utf8");
    let status: MutationStatus;
    try {
      const result = await runShellCommand(options.command, cwd, {
        timeoutMs: options.timeoutMs ?? 120_000,
      });
      status = result.timedOut ? "timeout" : result.exitCode === 0 ? "survived" : "killed";
    } catch (error) {
      writeFileSync(absolute, original, "utf8");
      throw error instanceof Error
        ? new PilotError(`Не удалось прогнать мутацию ${site.file}:${String(site.line)}: ${error.message}`, { exitCode: 2 })
        : error;
    } finally {
      writeFileSync(absolute, original, "utf8");
    }

    const mutant: MutantResult = {
      file: site.file,
      line: site.line,
      column: site.column,
      operator: site.operator,
      original: site.original,
      replacement: site.replacement,
      status,
      durationMs: Date.now() - mutantStarted,
    };
    mutants.push(mutant);
    options.onProgress?.(mutant, index + 1, selected.length);
  }

  const killed = mutants.filter((mutant) => mutant.status === "killed").length;
  const survived = mutants.filter((mutant) => mutant.status === "survived").length;
  const timedOut = mutants.filter((mutant) => mutant.status === "timeout").length;
  const score = mutants.length === 0 ? null : Math.round(((killed + timedOut) / mutants.length) * 100);

  return {
    command: options.command,
    files: files.map((file) => file.path),
    sites: allSites.length,
    mutants,
    killed,
    survived,
    timedOut,
    score,
    truncated: allSites.length > selected.length,
    durationMs: Date.now() - started,
  };
}

export function renderMutation(report: MutationReport): string {
  const lines = [
    `Команда: ${report.command}`,
    `Файлов: ${String(report.files.length)}, мутаций проверено: ${String(report.mutants.length)} из ${String(report.sites)}.`,
    `Убито: ${String(report.killed)}, выжило: ${String(report.survived)}, таймаутов: ${String(report.timedOut)}.`,
    report.score === null
      ? "Mutation score: нет мутаций для проверки."
      : `Mutation score: ${String(report.score)}/100.`,
  ];

  if (report.truncated) {
    lines.push(`Проверены не все мутации: лимит --max-mutants.`);
  }

  const survivors = report.mutants.filter((mutant) => mutant.status === "survived");
  if (survivors.length > 0) {
    lines.push("", "Выжившие мутации — тесты их не ловят:");
    for (const mutant of survivors) {
      lines.push(`  ${mutant.file}:${String(mutant.line)} ${mutant.operator} → ${mutant.replacement}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

/** Reads a changed file for mutation. Missing files are skipped by the caller. */
export function readSource(cwd: string, path: string): string {
  return readFileSync(join(cwd, path), "utf8");
}
