import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { splitDiffBlocks } from "./diff.js";
import { PilotError } from "./errors.js";

/**
 * Coverage-aware test generation: instead of asking the model to cover a whole
 * diff, narrow the request to changed lines that no test executed yet. Keeps
 * the prompt small and the generated tests meaningful.
 */
export type CoverageFormat = "lcov" | "istanbul" | "cobertura" | "go";

export interface FileCoverage {
  /** Lines that at least one test executed. */
  covered: Set<number>;
  /** Lines the coverage tool considers executable. */
  executable: Set<number>;
}

export interface CoverageReport {
  path: string;
  format: CoverageFormat;
  files: Map<string, FileCoverage>;
}

export interface CoverageGap {
  file: string;
  /** Changed, executable and never executed lines, ascending. */
  uncovered: number[];
}

export interface CoverageSummary {
  report: CoverageReport;
  /** Changed lines per file that the report knows about. */
  changed: Map<string, Set<number>>;
  gaps: CoverageGap[];
  /** Changed files with no entry in the report. */
  missing: string[];
  uncoveredLines: number;
}

const DEFAULT_REPORT_CANDIDATES = [
  "coverage/lcov.info",
  "lcov.info",
  "coverage/coverage-final.json",
  "coverage/coverage.json",
  "coverage.json",
  "coverage/cobertura-coverage.xml",
  "coverage/cobertura.xml",
  "cobertura-coverage.xml",
  "cobertura.xml",
  "coverage.xml",
  "coverage.out",
  "cover.out",
  "coverage/coverage.out",
];

function emptyFile(): FileCoverage {
  return { covered: new Set<number>(), executable: new Set<number>() };
}

function mark(file: FileCoverage, line: number, hits: number): void {
  if (!Number.isFinite(line) || line <= 0) return;
  file.executable.add(Math.trunc(line));
  if (hits > 0) file.covered.add(Math.trunc(line));
}

/** Parses `lcov.info` (`SF:` / `DA:` records). */
export function parseLcov(text: string): Map<string, FileCoverage> {
  const files = new Map<string, FileCoverage>();
  let current: FileCoverage | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      current = emptyFile();
      files.set(line.slice(3).trim(), current);
      continue;
    }
    if (line === "end_of_record") {
      current = undefined;
      continue;
    }
    if (!current || !line.startsWith("DA:")) continue;
    const [number, hits] = line.slice(3).split(",");
    const sourceLine = Number(number);
    const count = Number(hits);
    if (!Number.isFinite(sourceLine)) continue;
    mark(current, sourceLine, Number.isFinite(count) ? count : 0);
  }
  return files;
}

interface IstanbulLocation {
  start?: { line?: number };
  end?: { line?: number };
}

interface IstanbulFile {
  statementMap?: Record<string, IstanbulLocation>;
  s?: Record<string, number>;
  fnMap?: Record<string, { loc?: IstanbulLocation; decl?: IstanbulLocation }>;
  f?: Record<string, number>;
  branchMap?: Record<string, { loc?: IstanbulLocation }>;
  b?: Record<string, number[]>;
}

function parseIstanbulData(data: unknown): Map<string, FileCoverage> {
  const files = new Map<string, FileCoverage>();
  if (!data || typeof data !== "object") return files;
  for (const [path, raw] of Object.entries(data as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as IstanbulFile;
    if (!entry.statementMap && !entry.fnMap) continue;
    const file = emptyFile();
    for (const [id, location] of Object.entries(entry.statementMap ?? {})) {
      mark(file, location.start?.line ?? 0, entry.s?.[id] ?? 0);
    }
    for (const [id, location] of Object.entries(entry.fnMap ?? {})) {
      mark(file, location.decl?.start?.line ?? location.loc?.start?.line ?? 0, entry.f?.[id] ?? 0);
    }
    for (const [id, location] of Object.entries(entry.branchMap ?? {})) {
      const counts = entry.b?.[id] ?? [];
      mark(file, location.loc?.start?.line ?? 0, counts.some((count) => count > 0) ? 1 : 0);
    }
    if (file.executable.size > 0) files.set(path, file);
  }
  return files;
}

/** Parses Istanbul `coverage-final.json` / `coverage.json`. */
export function parseIstanbul(text: string): Map<string, FileCoverage> {
  try {
    return parseIstanbulData(JSON.parse(text));
  } catch {
    return new Map();
  }
}

/** Parses Cobertura XML (`<class filename>` / `<line number hits>`). */
export function parseCobertura(text: string): Map<string, FileCoverage> {
  const files = new Map<string, FileCoverage>();
  for (const classMatch of text.matchAll(/<class\b[^>]*\bfilename\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/class>/g)) {
    const file = emptyFile();
    for (const lineMatch of classMatch[2]!.matchAll(/<line\b[^>]*\bnumber\s*=\s*"(\d+)"[^>]*\bhits\s*=\s*"(\d+)"/g)) {
      mark(file, Number(lineMatch[1]), Number(lineMatch[2]));
    }
    if (file.executable.size > 0) files.set(classMatch[1]!, file);
  }
  return files;
}

/** Parses the Go cover profile written by `go test -coverprofile`. */
export function parseGoCover(text: string): Map<string, FileCoverage> {
  const files = new Map<string, FileCoverage>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("mode:")) continue;
    const match = /^(.+?):(\d+)\.\d+,(\d+)\.\d+\s+\d+\s+(\d+)$/.exec(line);
    if (!match) continue;
    const path = match[1]!;
    const start = Number(match[2]);
    const end = Number(match[3]);
    const hits = Number(match[4]);
    let file = files.get(path);
    if (!file) {
      file = emptyFile();
      files.set(path, file);
    }
    const last = Math.max(start, end);
    for (let current = start; current <= last && current - start < 5_000; current += 1) {
      mark(file, current, hits);
    }
  }
  return files;
}

export function sniffFormat(text: string): CoverageFormat | undefined {
  if (/^\s*mode:\s*(set|count|atomic)\b/m.test(text)) return "go";
  if (/(^|\n)SF:/.test(text) && /(^|\n)DA:/.test(text)) return "lcov";
  if (/<coverage[\s>]/.test(text)) return "cobertura";
  if (/^\s*[{[]/.test(text)) {
    try {
      const data = JSON.parse(text) as unknown;
      if (data && typeof data === "object") {
        const first = Object.values(data as Record<string, unknown>)[0];
        if (first && typeof first === "object" && "statementMap" in (first as object)) return "istanbul";
      }
    } catch {
      // Not JSON.
    }
  }
  return undefined;
}

export function parseCoverage(text: string, format: CoverageFormat): Map<string, FileCoverage> {
  if (format === "lcov") return parseLcov(text);
  if (format === "istanbul") return parseIstanbul(text);
  if (format === "cobertura") return parseCobertura(text);
  return parseGoCover(text);
}

function normalizePath(value: string, cwd: string): string {
  let path = value.replace(/\\/g, "/").trim();
  if (!path) return path;
  if (isAbsolute(path)) {
    const rel = relative(cwd, path).replace(/\\/g, "/");
    if (rel && !rel.startsWith("..")) path = rel;
  }
  return path.replace(/^\.\//, "");
}

/** Finds the closest coverage entry for a changed file, tolerating absolute and Go import paths. */
function lookupCoverage(files: Map<string, FileCoverage>, path: string): FileCoverage | undefined {
  const direct = files.get(path);
  if (direct) return direct;
  let best: FileCoverage | undefined;
  let bestLength = 0;
  for (const [candidate, value] of files) {
    const normalized = candidate.replace(/^\.\//, "");
    const match = normalized.endsWith(`/${path}`) || path.endsWith(`/${normalized}`);
    if (!match) continue;
    const length = Math.min(normalized.length, path.length);
    if (length > bestLength) {
      best = value;
      bestLength = length;
    }
  }
  return best;
}

export function resolveReportPath(cwd: string, explicit?: string): string | undefined {
  if (explicit) {
    const path = resolve(cwd, explicit);
    if (!existsSync(path)) {
      throw new PilotError(`Файл покрытия не найден: ${explicit}`, {
        hint: "Передайте существующий отчёт: --coverage-file coverage/lcov.info.",
        exitCode: 2,
      });
    }
    return path;
  }
  for (const candidate of DEFAULT_REPORT_CANDIDATES) {
    const path = join(cwd, candidate);
    if (existsSync(path)) return path;
  }
  return undefined;
}

/** Loads a report; throws when an explicit file exists but its format is unknown. */
export function loadCoverage(cwd: string, explicit?: string): CoverageReport | undefined {
  const path = resolveReportPath(cwd, explicit);
  if (!path) return undefined;
  const text = readFileSync(path, "utf8");
  const format = sniffFormat(text);
  if (!format) {
    throw new PilotError(`Не удалось распознать формат отчёта покрытия: ${path}`, {
      hint: "Поддерживаются lcov.info, coverage-final.json, cobertura.xml и Go coverprofile.",
      exitCode: 2,
    });
  }
  const files = parseCoverage(text, format);
  if (files.size === 0) {
    throw new PilotError(`Отчёт покрытия пуст: ${path}`, {
      hint: "Пересоберите покрытие с включёнными тестами.",
      exitCode: 2,
    });
  }
  const normalized = new Map<string, FileCoverage>();
  for (const [file, value] of files) normalized.set(normalizePath(file, cwd), value);
  return { path, format, files: normalized };
}

/** Maps every file in the diff to the line numbers added by it. */
export function changedLines(diff: string): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  for (const block of splitDiffBlocks(diff)) {
    if (!block.path || block.path === "(diff)" || block.path === "(unknown)") continue;
    const lines = new Set<number>();
    let newLine = 0;
    let inHunk = false;
    for (const raw of block.text.split(/\r?\n/)) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (hunk) {
        newLine = Number(hunk[1]);
        inHunk = true;
        continue;
      }
      if (!inHunk) continue;
      if (raw.startsWith("+")) {
        lines.add(newLine);
        newLine += 1;
      } else if (raw.startsWith(" ") || raw === "") {
        newLine += 1;
      }
    }
    if (lines.size > 0) result.set(block.path, lines);
  }
  return result;
}

export interface CoverageGapOptions {
  /** Cap on reported files so the prompt stays small. */
  maxFiles?: number;
  /** Cap on reported lines per file. */
  maxLinesPerFile?: number;
}

/** Intersects changed lines with executable-but-uncovered lines from the report. */
export function coverageGaps(
  report: CoverageReport,
  changed: Map<string, Set<number>>,
  options: CoverageGapOptions = {},
): CoverageSummary {
  const maxFiles = options.maxFiles ?? 25;
  const maxLines = options.maxLinesPerFile ?? 80;
  const gaps: CoverageGap[] = [];
  const missing: string[] = [];
  let uncoveredLines = 0;

  for (const [file, lines] of [...changed].sort(([a], [b]) => a.localeCompare(b))) {
    const entry = lookupCoverage(report.files, file);
    if (!entry) {
      missing.push(file);
      continue;
    }
    const uncovered = [...lines]
      .filter((line) => entry.executable.has(line) && !entry.covered.has(line))
      .sort((a, b) => a - b);
    if (uncovered.length === 0) continue;
    uncoveredLines += uncovered.length;
    gaps.push({ file, uncovered: uncovered.slice(0, maxLines) });
  }

  return {
    report,
    changed,
    gaps: gaps.slice(0, maxFiles),
    missing,
    uncoveredLines,
  };
}

/** Prompt fragment: the exact lines the model should cover. */
export function formatCoverageGaps(summary: CoverageSummary): string {
  const lines = ["COVERAGE_GAPS: changed lines that no test executed. Cover these lines first:"];
  for (const gap of summary.gaps) lines.push(`- ${gap.file}: ${gap.uncovered.join(", ")}`);
  if (summary.missing.length > 0) {
    lines.push(`COVERAGE_MISSING: no coverage data for ${summary.missing.join(", ")}.`);
  }
  return lines.join("\n");
}

/** Short Russian summary for logs and meta. */
export function describeCoverage(summary: CoverageSummary): string {
  const parts = [`${summary.uncoveredLines} непокрытых строк в ${summary.gaps.length} файл(ах)`];
  if (summary.missing.length > 0) parts.push(`нет данных по ${summary.missing.length} файл(ам)`);
  return parts.join(", ");
}
