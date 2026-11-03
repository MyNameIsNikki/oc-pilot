import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PilotError } from "../errors.js";
import { runGit } from "../git.js";
import { isCodeFile, isGeneratedPath } from "./source.js";
import type { CommitFiles, SourceFile } from "./model.js";

const MAX_FILES = 3_000;
const MAX_FILE_BYTES = 512 * 1024;
const SLOPIGNORE = ".oc-pilot/slopignore";

export interface LoadResult {
  files: SourceFile[];
  truncated: boolean;
}

export interface CollectOptions {
  exclude?: string[];
  sinceDays?: number;
}

/** Builds a predicate from `--exclude` values and `.oc-pilot/slopignore`. */
export function excludeMatcher(cwd: string, patterns: string[] = []): (path: string) => boolean {
  const all = [...patterns];
  const ignoreFile = resolve(cwd, SLOPIGNORE);
  if (existsSync(ignoreFile)) {
    for (const line of readFileSync(ignoreFile, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) all.push(trimmed);
    }
  }

  const rules = all.map((raw) => {
    const pattern = raw.trim().replace(/\\/g, "/");
    if (pattern.includes("*")) {
      const source = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "\u0000")
        .replace(/\*/g, "[^/]*")
        .replace(/\u0000/g, ".*");
      return new RegExp(`^${source}$`);
    }
    return pattern;
  });

  return (path: string): boolean => {
    const normalized = path.replace(/\\/g, "/");
    return rules.some((rule) => (typeof rule === "string" ? normalized.includes(rule) : rule.test(normalized)));
  };
}

function safeRead(cwd: string, path: string): string | undefined {
  try {
    const content = readFileSync(resolve(cwd, path), "utf8");
    if (content.length > MAX_FILE_BYTES) return undefined;
    return content.startsWith("\uFEFF") ? content.slice(1) : content;
  } catch {
    return undefined;
  }
}

export function readSourceFiles(cwd: string, paths: string[]): SourceFile[] {
  const files: SourceFile[] = [];
  for (const path of paths) {
    const text = safeRead(cwd, path);
    if (text === undefined) continue;
    files.push({ path: path.replace(/\\/g, "/"), text });
  }
  return files;
}

function requireRepo(cwd: string): void {
  const check = runGit(["rev-parse", "--is-inside-work-tree"], cwd);
  if (check.status !== 0 || check.stdout.trim() !== "true") {
    throw new PilotError("Команда slop работает внутри git-репозитория", {
      hint: "Проверьте, что вы в корне проекта и git установлен.",
      exitCode: 2,
    });
  }
}

/** Reads every tracked and untracked code file, filtered by ignore rules. */
export function readRepository(cwd: string, options: CollectOptions = {}): LoadResult {
  requireRepo(cwd);
  const listed = runGit(["ls-files", "-co", "--exclude-standard", "--full-name", "-z"], cwd);
  if (listed.status !== 0) {
    throw new PilotError("Не удалось получить список файлов", { hint: listed.stderr.trim(), exitCode: 1 });
  }

  const excluded = excludeMatcher(cwd, options.exclude);
  const paths = listed.stdout
    .split("\0")
    .filter(Boolean)
    .map((path) => path.replace(/\\/g, "/"))
    .filter((path) => isCodeFile(path) && !isGeneratedPath(path) && !excluded(path))
    .sort();

  const truncated = paths.length > MAX_FILES;
  return { files: readSourceFiles(cwd, paths.slice(0, MAX_FILES)), truncated };
}

/** Files touched by the working tree relative to `ref`. */
export function changedFiles(cwd: string, ref: string): string[] {
  const [tracked, untracked] = [
    runGit(["diff", "--name-only", ref, "--"], cwd),
    runGit(["ls-files", "-o", "--exclude-standard", "--full-name"], cwd),
  ];
  if (tracked.status !== 0) {
    throw new PilotError(`Не удалось сравнить с ${ref}`, {
      hint: tracked.stderr.trim() || "Проверьте, что ревизия существует.",
      exitCode: 2,
    });
  }
  const set = new Set<string>();
  for (const line of `${tracked.stdout}\n${untracked.stdout}`.split("\n")) {
    const path = line.trim().replace(/\\/g, "/");
    if (path && isCodeFile(path) && !isGeneratedPath(path)) set.add(path);
  }
  return [...set].sort();
}

/** Reads the state of the given paths at `ref`; missing files become empty. */
export function readAtRef(cwd: string, ref: string, paths: string[]): SourceFile[] {
  const files: SourceFile[] = [];
  for (const path of paths) {
    const result = runGit(["show", `${ref}:${path}`], cwd);
    files.push({ path, text: result.status === 0 ? result.stdout : "" });
  }
  return files;
}

/** Commits with their touched files, newest first. */
export function collectCommits(cwd: string, options: { sinceDays?: number; limit?: number; range?: string } = {}): CommitFiles[] {
  const args = ["log", "--no-merges", "--name-only", "--format=%x01%H%x09%at"];
  if (options.range) args.push(options.range);
  else if (options.sinceDays) args.push(`--since=${String(options.sinceDays)} days ago`);
  if (options.limit) args.push(`-n${String(options.limit)}`);

  const result = runGit(args, cwd);
  if (result.status !== 0) return [];

  const commits: CommitFiles[] = [];
  let current: CommitFiles | undefined;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("\u0001")) {
      const [sha, timestamp] = line.slice(1).split("\t");
      current = { sha: sha ?? "", timestamp: Number(timestamp ?? 0) * 1000, files: [] };
      commits.push(current);
      continue;
    }
    const path = line.trim().replace(/\\/g, "/");
    if (path && current && isCodeFile(path)) current.files.push(path);
  }

  return commits.filter((commit) => commit.files.length > 0);
}

/** Line number to author timestamp from `git blame --porcelain`. */
export function blameTimestamps(cwd: string, file: string, ref?: string): Map<number, number> {
  const args = ["blame", "--porcelain"];
  if (ref) args.push(ref);
  args.push("--", file);
  const result = runGit(args, cwd);
  const map = new Map<number, number>();
  if (result.status !== 0) return map;

  let line = 0;
  let timestamp = 0;
  for (const row of result.stdout.split("\n")) {
    const header = /^[0-9a-f]{7,40}\s+\d+\s+(\d+)(?:\s+\d+)?$/i.exec(row);
    if (header) {
      line = Number(header[1]);
      continue;
    }
    if (row.startsWith("author-time ")) {
      timestamp = Number(row.slice("author-time ".length)) || 0;
      continue;
    }
    if (row.startsWith("\t") && line > 0 && timestamp > 0) {
      map.set(line, timestamp * 1000);
    }
  }

  return map;
}

/** Lazily resolves line age in days, caching one blame per file. */
export function lineAges(cwd: string, enabled: boolean, ref?: string): (file: string, line: number) => number | undefined {
  if (!enabled) return () => undefined;
  const cache = new Map<string, Map<number, number>>();
  const now = Date.now();

  return (file: string, line: number): number | undefined => {
    let stamps = cache.get(file);
    if (!stamps) {
      stamps = blameTimestamps(cwd, file, ref);
      cache.set(file, stamps);
    }
    const timestamp = stamps.get(line);
    if (!stamps.size || timestamp === undefined) return undefined;
    return Math.max(0, Math.floor((now - timestamp) / 86_400_000));
  };
}
