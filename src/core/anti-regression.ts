import { splitDiffBlocks } from "./diff.js";
import { PilotError } from "./errors.js";
import { runGit } from "./git.js";
import { isCodeFile, isGeneratedPath, isTestFile } from "./slop/source.js";

export type RegressionKind = "readded-line" | "readded-import";

export interface RegressionCommit {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
}

export interface RegressionFinding {
  file: string;
  line: number;
  text: string;
  kind: RegressionKind;
  severity: "high";
  commit: RegressionCommit;
}

export interface AntiRegressionReport {
  findings: RegressionFinding[];
  checkedLines: number;
  files: string[];
  status: "pass" | "fail";
}

export interface AntiRegressionOptions {
  /** How many commits per file to inspect (default 200). */
  maxCommits?: number;
  /** Inspect commits since this date or ref. */
  since?: string;
  /** Maximum added lines to check (default 80). */
  maxLines?: number;
}

const MIN_LINE_LENGTH = 12;
const DEFAULT_MAX_COMMITS = 200;
const DEFAULT_MAX_LINES = 80;
const RECORD = "\u001e";
const FIELD = "\u001f";

interface AddedLine {
  file: string;
  line: number;
  text: string;
}

function normalize(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

function isImportLine(line: string): boolean {
  return (
    /^\s*import\b/.test(line) ||
    /^\s*export\b[^=]*\bfrom\b/.test(line) ||
    /^\s*(?:const|let|var)\s+\w+\s*=\s*require\(/.test(line)
  );
}

function interesting(line: string): boolean {
  const text = normalize(line);
  if (text.length < MIN_LINE_LENGTH) return false;
  if (/^[{}()[\],;]+$/.test(text)) return false;
  if (/^(?:\/\/|#|\/\*|\*)/.test(text)) return false;
  return true;
}

function parseCommit(header: string): RegressionCommit | undefined {
  const [hash, author, date, ...subject] = header.split(FIELD);
  if (!hash || hash.length < 7) return undefined;
  return {
    hash,
    shortHash: hash.slice(0, 7),
    author: author ?? "",
    date: date ?? "",
    subject: subject.join(FIELD).trim(),
  };
}

/** Added non-test, non-generated code lines from a unified diff. */
export function addedLines(diff: string): AddedLine[] {
  const lines: AddedLine[] = [];
  for (const block of splitDiffBlocks(diff)) {
    if (block.path === "(diff)" || block.path === "(unknown)") continue;
    if (!isCodeFile(block.path) || isTestFile(block.path) || isGeneratedPath(block.path)) continue;
    let newLine = 0;
    for (const raw of block.text.split(/\r?\n/)) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (hunk) {
        newLine = Number(hunk[1]);
        continue;
      }
      if (raw.startsWith("+++") || raw.startsWith("---")) continue;
      if (raw.startsWith("+")) {
        const text = raw.slice(1);
        if (interesting(text)) lines.push({ file: block.path, line: newLine, text: normalize(text) });
        newLine += 1;
      } else if (raw.startsWith(" ")) {
        newLine += 1;
      }
    }
  }
  return lines;
}

/** Most recent deletion of each line in the file's git history. */
export function deletedLines(cwd: string, file: string, options: AntiRegressionOptions = {}): Map<string, RegressionCommit> {
  const args = [
    "log",
    "-p",
    "-U0",
    "--no-color",
    "--format=%x1e%H%x1f%an%x1f%aI%x1f%s",
    `--max-count=${String(options.maxCommits ?? DEFAULT_MAX_COMMITS)}`,
  ];
  if (options.since) args.push(`--since=${options.since}`);
  args.push("--", file);

  const result = runGit(args, cwd);
  if (result.status !== 0) return new Map();

  const deleted = new Map<string, RegressionCommit>();
  let commit: RegressionCommit | undefined;
  for (const raw of result.stdout.split(/\r?\n/)) {
    if (raw.startsWith(RECORD)) {
      commit = parseCommit(raw.slice(1));
      continue;
    }
    if (!commit || !raw.startsWith("-") || raw.startsWith("---")) continue;
    const text = normalize(raw.slice(1));
    if (!interesting(text)) continue;
    if (!deleted.has(text)) deleted.set(text, commit);
  }
  return deleted;
}

/**
 * Finds lines that the current diff adds back after a commit removed the same
 * line from the same file. The comparison is textual and whitespace-normalized.
 */
export function analyzeAntiRegression(
  cwd: string,
  diff: string,
  options: AntiRegressionOptions = {},
): AntiRegressionReport {
  const lines = addedLines(diff).slice(0, options.maxLines ?? DEFAULT_MAX_LINES);
  const files = [...new Set(lines.map((line) => line.file))].sort();
  if (files.length === 0) {
    return { findings: [], checkedLines: 0, files: [], status: "pass" };
  }

  const findings: RegressionFinding[] = [];
  for (const file of files) {
    const deleted = deletedLines(cwd, file, options);
    if (deleted.size === 0) continue;
    for (const line of lines.filter((item) => item.file === file)) {
      const commit = deleted.get(line.text);
      if (!commit) continue;
      findings.push({
        file: line.file,
        line: line.line,
        text: line.text,
        kind: isImportLine(line.text) ? "readded-import" : "readded-line",
        severity: "high",
        commit,
      });
    }
  }

  findings.sort(
    (left, right) =>
      left.file.localeCompare(right.file) || left.line - right.line || left.commit.date.localeCompare(right.commit.date),
  );

  return {
    findings,
    checkedLines: lines.length,
    files,
    status: findings.length > 0 ? "fail" : "pass",
  };
}

/** Russian summary for the CLI and MCP text output. */
export function describeAntiRegression(findings: RegressionFinding[]): string {
  if (findings.length === 0) return "Повторно добавленных удалённых строк не найдено.";
  const lines = findings
    .slice(0, 10)
    .map(
      (finding) =>
        `- ${finding.file}:${String(finding.line)} [${finding.kind}]: ${finding.commit.shortHash} ${finding.commit.subject} (${finding.commit.author})`,
    );
  if (findings.length > 10) lines.push(`- …и ещё ${String(findings.length - 10)}`);
  return lines.join("\n");
}

/** Validates that the working directory is a git repository. */
export function requireGitRepository(cwd: string): void {
  const result = runGit(["rev-parse", "--is-inside-work-tree"], cwd);
  if (result.status !== 0 || result.stdout.trim() !== "true") {
    throw new PilotError("Anti-regression shield работает внутри git-репозитория", {
      hint: "Проверьте, что вы в корне проекта и git установлен.",
      exitCode: 2,
    });
  }
}
