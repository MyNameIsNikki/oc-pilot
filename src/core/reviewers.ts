import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runGit } from "./git.js";

/** One parsed line of a CODEOWNERS file. */
export interface CodeownersRule {
  pattern: string;
  owners: string[];
}

export interface ReviewerCandidate {
  name: string;
  email: string;
  /** Commits by this author that touched one of the changed files. */
  commits: number;
  /** Distinct changed files this author has touched. */
  files: number;
  /** commits divided by the total number of author/file hits, 0..1. */
  share: number;
}

export interface ReviewerReport {
  files: string[];
  candidates: ReviewerCandidate[];
  /** Owners declared in CODEOWNERS for the changed files, in file order. */
  codeowners: string[];
  /** Author/file hits examined, useful to explain an empty result. */
  commitsScanned: number;
}

export interface SuggestOptions {
  limit?: number;
  /** Commits per file to look at. */
  depth?: number;
  /** Case-insensitive substrings matched against name and email. */
  exclude?: string[];
}

const DEFAULT_LIMIT = 3;
const DEFAULT_DEPTH = 50;
const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];
const BOT = /(\[bot\]|(?:^|[-_.])bot(?:$|[-_.])|dependabot|renovate|github-actions|^ci$)/i;

function escapeChar(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Translates a CODEOWNERS pattern into a regular expression. GitHub and GitLab
 * both anchor patterns that contain a slash at the repository root and match
 * patterns without a slash at any depth; a trailing slash means "everything
 * below this directory".
 */
export function codeownersPattern(pattern: string): RegExp | undefined {
  let value = pattern.trim();
  if (!value || value.startsWith("!")) return undefined;
  const directory = value.endsWith("/");
  value = value.replace(/^\/+/, "");
  if (directory) value += "**";

  let body = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === "*") {
      if (value[index + 1] === "*") {
        body += ".*";
        index += 1;
      } else {
        body += "[^/]*";
      }
    } else if (char === "?") {
      body += "[^/]";
    } else {
      body += escapeChar(char);
    }
  }

  const prefix = value.includes("/") ? "^" : "(?:^|.*/)";
  return new RegExp(`${prefix}${body}$`);
}

/** Parses a CODEOWNERS file. Comments and malformed lines are skipped. */
export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const pattern = parts[0];
    const owners = parts.slice(1);
    if (!pattern || owners.length === 0) continue;
    rules.push({ pattern, owners });
  }
  return rules;
}

export function loadCodeowners(cwd: string): CodeownersRule[] | undefined {
  for (const relative of CODEOWNERS_PATHS) {
    const path = join(cwd, relative);
    if (!existsSync(path)) continue;
    try {
      return parseCodeowners(readFileSync(path, "utf8"));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Last matching rule wins, matching both GitHub and GitLab semantics. */
export function codeownersFor(files: string[], rules: CodeownersRule[]): string[] {
  const owners: string[] = [];
  for (const file of files) {
    let matched: string[] | undefined;
    for (const rule of rules) {
      const regex = codeownersPattern(rule.pattern);
      if (regex?.test(file)) matched = rule.owners;
    }
    for (const owner of matched ?? []) {
      if (!owners.includes(owner)) owners.push(owner);
    }
  }
  return owners;
}

interface AuthorHit {
  name: string;
  email: string;
  commits: number;
  files: Set<string>;
}

/**
 * Ranks people by how often they touched the files in the current diff. The
 * history comes from `git log`, so the result is deterministic and needs no
 * network access.
 */
export function suggestReviewers(cwd: string, files: string[], options: SuggestOptions = {}): ReviewerReport {
  const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
  const depth = Math.max(1, options.depth ?? DEFAULT_DEPTH);
  const exclude = (options.exclude ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean);
  const unique = [...new Set(files.map((file) => file.replace(/\\/g, "/").trim()).filter(Boolean))];

  const hits = new Map<string, AuthorHit>();
  let commitsScanned = 0;

  for (const file of unique) {
    const result = runGit(["log", `-n${depth}`, "--no-merges", "--format=%aN%x09%aE", "--", file], cwd);
    if (result.status !== 0) continue;
    for (const line of result.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [name = "", email = ""] = line.split("\t");
      const author = name.trim();
      const address = email.trim();
      if (!author || BOT.test(author) || BOT.test(address)) continue;
      const haystack = `${author} ${address}`.toLowerCase();
      if (exclude.some((value) => haystack.includes(value))) continue;

      commitsScanned += 1;
      const key = `${author} <${address}>`.toLowerCase();
      const entry = hits.get(key) ?? { name: author, email: address, commits: 0, files: new Set<string>() };
      entry.commits += 1;
      entry.files.add(file);
      hits.set(key, entry);
    }
  }

  const candidates: ReviewerCandidate[] = [...hits.values()]
    .map((entry) => ({
      name: entry.name,
      email: entry.email,
      commits: entry.commits,
      files: entry.files.size,
      share: commitsScanned > 0 ? Math.round((entry.commits / commitsScanned) * 100) / 100 : 0,
    }))
    .sort((left, right) => right.commits - left.commits || right.files - left.files || left.name.localeCompare(right.name))
    .slice(0, limit);

  const rules = loadCodeowners(cwd);
  return {
    files: unique,
    candidates,
    codeowners: rules ? codeownersFor(unique, rules) : [],
    commitsScanned,
  };
}

/** Russian plural form for a count: 1 коммит, 2 коммита, 5 коммитов. */
function plural(count: number, one: string, few: string, many: string): string {
  const mod100 = count % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = count % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/** Human-readable report for the terminal. */
export function describeReviewers(report: ReviewerReport): string {
  const lines: string[] = [`Изменённых файлов: ${report.files.length}`];
  if (report.codeowners.length > 0) {
    lines.push(`CODEOWNERS: ${report.codeowners.join(", ")}`);
  }
  if (report.candidates.length === 0) {
    lines.push("", "Недостаточно истории: ни одного автора по изменённым файлам не найдено.");
    return `${lines.join("\n")}\n`;
  }
  lines.push("", "Кандидаты в ревьюеры:");
  const width = Math.max(...report.candidates.map((candidate) => candidate.name.length));
  report.candidates.forEach((candidate, index) => {
    const share = `${Math.round(candidate.share * 100)}%`;
    const commits = plural(candidate.commits, "коммит", "коммита", "коммитов");
    const files = plural(candidate.files, "файл", "файла", "файлов");
    lines.push(
      `  ${index + 1}. ${candidate.name.padEnd(width)} — ${candidate.commits} ${commits}, ${candidate.files} ${files} (${share}) <${candidate.email}>`,
    );
  });
  return `${lines.join("\n")}\n`;
}
