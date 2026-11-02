import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { PilotError } from "./errors.js";
import { log } from "./log.js";

interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

const MAX_BUFFER = 128 * 1024 * 1024;

function git(args: string[], cwd: string): GitResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    env: {
      ...process.env,
      GIT_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
    },
  });

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: (result.stderr ?? "").trim(),
  };
}

/** Runs git with stdin support; used by snapshot apply. */
export function runGit(args: string[], cwd: string, input?: string): GitResult {
  if (input === undefined) return git(args, cwd);
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    input,
    env: {
      ...process.env,
      GIT_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: (result.stderr ?? "").trim(),
  };
}

function failIfError(result: GitResult, args: string[]): string {
  if (result.status === 0) return result.stdout;
  throw new PilotError(`git ${args.join(" ")} завершился с ошибкой`, {
    hint: result.stderr || "Проверьте, что вы находитесь в git-репозитории.",
  });
}

export function isGitRepo(cwd: string): boolean {
  const result = git(["rev-parse", "--is-inside-work-tree"], cwd);
  return result.status === 0 && result.stdout.trim() === "true";
}

export function getRepoRoot(cwd: string): string {
  if (!isGitRepo(cwd)) {
    throw new PilotError("Текущая директория не является git-репозиторием", {
      hint: "Запустите команду в репозитории или передайте --diff <file>.",
      exitCode: 2,
    });
  }
  const result = git(["rev-parse", "--show-toplevel"], cwd);
  const root = failIfError(result, ["rev-parse", "--show-toplevel"]).trim();
  if (!root) throw new PilotError("Не удалось определить корень git-репозитория");
  return root;
}

function hasHead(repoRoot: string): boolean {
  return git(["rev-parse", "--verify", "HEAD"], repoRoot).status === 0;
}

function resolvePathspecs(cwd: string, repoRoot: string, paths: string[] | undefined): string[] {
  if (!paths || paths.length === 0) return [];
  return paths.map((path) => {
    if (isAbsolute(path) || /[*?[\]]/.test(path)) return path;
    const absolute = resolve(cwd, path);
    const rel = relative(repoRoot, absolute);
    return rel.startsWith("..") ? path : rel.split(sep).join("/");
  });
}

function collectUntracked(repoRoot: string, pathspecs: string[]): { diff: string; files: string[] } {
  const list = git(["ls-files", "--others", "--exclude-standard", "--full-name", "-z"], repoRoot);
  if (list.status !== 0) return { diff: "", files: [] };

  let files = list.stdout.split("\0").filter(Boolean).map((file) => file.replace(/\\/g, "/"));
  const literalPathspecs = pathspecs.filter((path) => !/[*?[\]]/.test(path));
  if (literalPathspecs.length > 0) {
    files = files.filter((file) =>
      literalPathspecs.some((path) => file === path || file.startsWith(path.endsWith("/") ? path : `${path}/`)),
    );
  }

  const limited = files.slice(0, 200);
  if (files.length > limited.length) {
    log.warn(`Необработанных файлов больше 200; показаны первые ${limited.length}.`);
  }

  const chunks: string[] = [];
  for (const file of limited) {
    const result = git(["diff", "--no-index", "--no-color", "--no-ext-diff", "--", "/dev/null", file], repoRoot);
    if (result.status === 0 || result.status === 1) {
      if (result.stdout) chunks.push(result.stdout);
    } else if (result.stderr) {
      log.warn(`Не удалось построить diff для ${file}: ${result.stderr}`);
    }
  }

  return { diff: chunks.join(""), files: limited };
}

export interface GitDiffOptions {
  cwd: string;
  staged?: boolean;
  unstaged?: boolean;
  base?: string;
  includeUntracked?: boolean;
  paths?: string[];
}

export interface GitDiffResult {
  diff: string;
  repoRoot: string;
  untracked: string[];
}

export function collectGitDiff(options: GitDiffOptions): GitDiffResult {
  const repoRoot = getRepoRoot(options.cwd);
  if (options.base && (options.staged || options.unstaged)) {
    throw new PilotError("--base нельзя комбинировать с --staged или --unstaged", { exitCode: 2 });
  }

  const pathspecs = resolvePathspecs(options.cwd, repoRoot, options.paths);
  const args = ["diff", "--no-color", "--no-ext-diff", "--find-renames"];

  if (options.base) {
    if (git(["rev-parse", "--verify", options.base], repoRoot).status !== 0) {
      throw new PilotError(`Базовая ветка или коммит не найдены: ${options.base}`, {
        hint: "Проверьте имя ветки: git branch --all",
        exitCode: 2,
      });
    }
    args.push(`${options.base}...HEAD`);
  } else if (options.staged && !options.unstaged) {
    args.push("--cached");
  } else if (options.unstaged) {
    // Plain `git diff` compares the working tree with the index.
  } else {
    if (!hasHead(repoRoot)) {
      throw new PilotError("В репозитории ещё нет коммитов (HEAD отсутствует)", {
        hint: "Сделайте первый коммит или используйте --staged / --diff <file>.",
        exitCode: 2,
      });
    }
    args.push("HEAD");
  }

  if (pathspecs.length > 0) args.push("--", ...pathspecs);

  const result = git(args, repoRoot);
  if (result.status !== 0) {
    throw new PilotError(`git ${args.join(" ")} завершился с ошибкой`, {
      hint: result.stderr || "Проверьте аргументы diff.",
    });
  }

  let diff = result.stdout;
  let untracked: string[] = [];
  if (options.includeUntracked) {
    const extra = collectUntracked(repoRoot, pathspecs);
    if (extra.diff) diff = `${diff}${extra.diff}`;
    untracked = extra.files;
  }

  return { diff, repoRoot, untracked };
}
