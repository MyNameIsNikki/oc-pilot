import { runShellCommand } from "./command.js";
import { PilotError } from "./errors.js";
import { runGit } from "./git.js";
import { createShadow } from "./shadow.js";

export interface MaydayBisectStep {
  sha: string;
  subject: string;
  verdict: "good" | "bad" | "error";
  output?: string;
}

export interface MaydayBadCommit {
  sha: string;
  subject: string;
  author: string;
  date: string;
  files: number;
  additions: number;
  deletions: number;
}

export interface MaydayBisectResult {
  status: "found" | "none" | "error";
  good: string;
  bad: string;
  firstBad?: MaydayBadCommit;
  steps: MaydayBisectStep[];
  summary: string;
  content: string;
}

export type MaydayRollbackStatus = "ready" | "failed" | "none";

export interface MaydayRollbackResult {
  status: MaydayRollbackStatus;
  branch?: string;
  to: string;
  reverted: number;
  tests: "pass" | "fail" | "skipped";
  testOutput?: string;
  summary: string;
  content: string;
}

export interface MaydayBisectOptions {
  command: string;
  timeoutMs?: number;
  maxSteps?: number;
}

export interface MaydayRollbackOptions {
  testCommand?: string;
  timeoutMs?: number;
  runTests?: boolean;
  branch?: string;
  force?: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 3_000;

function cap(output: string): string {
  return output.length > MAX_OUTPUT ? output.slice(-MAX_OUTPUT) : output;
}

function resolveCommit(cwd: string, ref: string): string {
  if (!ref || ref.startsWith("-")) {
    throw new PilotError(`Некорректная ссылка: ${ref}`, { exitCode: 2 });
  }
  const result = runGit(["rev-parse", "--verify", `${ref}^{commit}`], cwd);
  if (result.status !== 0) {
    throw new PilotError(`Коммит не найден: ${ref}`, {
      hint: result.stderr.trim() || undefined,
      exitCode: 2,
    });
  }
  return result.stdout.trim();
}

function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  return runGit(["merge-base", "--is-ancestor", ancestor, descendant], cwd).status === 0;
}

function revList(cwd: string, from: string, to: string, noMerges = false): string[] {
  const args = ["rev-list", "--reverse", "--first-parent"];
  if (noMerges) args.push("--no-merges");
  args.push(`${from}..${to}`);
  const result = runGit(args, cwd);
  if (result.status !== 0) {
    throw new PilotError("Не удалось получить список коммитов", {
      hint: result.stderr.trim() || undefined,
      exitCode: 2,
    });
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function subjectOf(cwd: string, sha: string): string {
  return runGit(["show", "-s", "--format=%s", sha], cwd).stdout.trim();
}

function badCommit(cwd: string, sha: string): MaydayBadCommit {
  const meta = runGit(["show", "-s", "--format=%an%n%ad%n%s", "--date=short", sha], cwd).stdout.trim();
  const [author = "unknown", date = "unknown", ...subject] = meta.split(/\r?\n/);
  const shortstat = runGit(["show", "--shortstat", "--format=", sha], cwd).stdout;
  const files = /(\d+) files? changed/.exec(shortstat)?.[1];
  const additions = /(\d+) insertions?/.exec(shortstat)?.[1];
  const deletions = /(\d+) deletions?/.exec(shortstat)?.[1];
  return {
    sha,
    author,
    date,
    subject: subject.join(" "),
    files: files ? Number(files) : 0,
    additions: additions ? Number(additions) : 0,
    deletions: deletions ? Number(deletions) : 0,
  };
}

/** Binary-searches the first commit where the command starts failing. */
export async function bisectMayday(
  cwd: string,
  goodRef: string,
  badRef: string,
  options: MaydayBisectOptions,
): Promise<MaydayBisectResult> {
  const good = resolveCommit(cwd, goodRef);
  const bad = resolveCommit(cwd, badRef);
  if (good === bad) {
    throw new PilotError("good и bad указывают на один коммит", { exitCode: 2 });
  }
  if (!isAncestor(cwd, good, bad)) {
    throw new PilotError("good не является предком bad", {
      hint: "Проверьте порядок коммитов.",
      exitCode: 2,
    });
  }

  const list = revList(cwd, good, bad);
  if (list.length === 0) {
    return {
      status: "none",
      good,
      bad,
      steps: [],
      summary: "[MAYDAY NONE]: между good и bad нет коммитов.",
      content: "Mayday: none\n",
    };
  }

  const timeoutMs = Math.max(1_000, Math.min(900_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const maxSteps = Math.max(1, Math.min(64, options.maxSteps ?? 24));
  const steps: MaydayBisectStep[] = [];
  let low = 0;
  let high = list.length - 1;
  let firstBad: string | undefined;

  while (low <= high && steps.length < maxSteps) {
    const mid = Math.floor((low + high) / 2);
    const sha = list[mid]!;
    const shadow = createShadow(cwd, "mayday-bisect", sha);
    let run;
    try {
      run = await runShellCommand(options.command, shadow.dir, { timeoutMs });
    } finally {
      shadow.cleanup();
    }
    if (run.timedOut) {
      const result: MaydayBisectResult = {
        status: "error",
        good,
        bad,
        steps,
        summary: `[MAYDAY ERROR]: тест не завершился на ${sha.slice(0, 8)}.`,
        content: "",
      };
      result.content = renderMaydayBisect(result);
      return result;
    }
    const verdict = run.exitCode === 0 ? "good" : "bad";
    steps.push({ sha, subject: subjectOf(cwd, sha), verdict, output: cap(run.output) });
    if (verdict === "bad") {
      firstBad = sha;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  if (!firstBad) {
    const result: MaydayBisectResult = {
      status: "none",
      good,
      bad,
      steps,
      summary: "[MAYDAY NONE]: ни один проверенный коммит не падает.",
      content: "",
    };
    result.content = renderMaydayBisect(result);
    return result;
  }

  const result: MaydayBisectResult = {
    status: "found",
    good,
    bad,
    firstBad: badCommit(cwd, firstBad),
    steps,
    summary: `[MAYDAY FOUND]: первый плохой коммит ${firstBad.slice(0, 8)}.`,
    content: "",
  };
  result.content = renderMaydayBisect(result);
  return result;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

/** Reverts everything after `to` in a shadow worktree and exposes a rollback branch. */
export async function rollbackMayday(
  cwd: string,
  toRef: string,
  options: MaydayRollbackOptions = {},
): Promise<MaydayRollbackResult> {
  const to = resolveCommit(cwd, toRef);
  const head = resolveCommit(cwd, "HEAD");
  if (!isAncestor(cwd, to, head)) {
    throw new PilotError("Целевой коммит не является предком HEAD", {
      hint: "Откат возможен только назад по истории.",
      exitCode: 2,
    });
  }

  const list = revList(cwd, to, head, true);
  if (list.length === 0) {
    return {
      status: "none",
      to,
      reverted: 0,
      tests: "skipped",
      summary: "[MAYDAY NONE]: после целевого коммита нет не-merge коммитов.",
      content: "Mayday: none\n",
    };
  }

  const branch = options.branch?.trim() || `oc-pilot/mayday-rollback-${timestamp()}`;
  if (runGit(["rev-parse", "--verify", `refs/heads/${branch}`], cwd).status === 0 && !options.force) {
    throw new PilotError(`Ветка уже существует: ${branch}`, {
      hint: "Укажите другую --branch или добавьте --force.",
      exitCode: 2,
    });
  }

  const shadow = createShadow(cwd, "mayday-rollback", "HEAD");
  try {
    const order = [...list].reverse();
    const revert = runGit(["revert", "--no-commit", ...order], shadow.dir);
    if (revert.status !== 0) {
      throw new PilotError("Не удалось откатить коммиты", {
        hint: revert.stderr.trim() || revert.stdout.trim() || undefined,
        exitCode: 2,
      });
    }
    const commit = runGit(["commit", "-m", `mayday: rollback to ${to.slice(0, 8)}`], shadow.dir);
    if (commit.status !== 0) {
      throw new PilotError("Не удалось создать rollback-коммит", {
        hint: commit.stderr.trim() || "Проверьте git user.name и user.email.",
        exitCode: 2,
      });
    }
    const sha = runGit(["rev-parse", "HEAD"], shadow.dir).stdout.trim();

    const runTests = options.runTests !== false;
    const testCommand = options.testCommand?.trim();
    let tests: "pass" | "fail" | "skipped" = "skipped";
    let testOutput: string | undefined;
    if (runTests && testCommand) {
      const timeoutMs = Math.max(1_000, Math.min(1_800_000, options.timeoutMs ?? 300_000));
      const run = await runShellCommand(testCommand, shadow.dir, { timeoutMs });
      tests = run.exitCode === 0 && !run.timedOut ? "pass" : "fail";
      testOutput = cap(run.output);
    }

    const branchArgs = options.force
      ? ["branch", "-f", branch, sha]
      : ["branch", branch, sha];
    const created = runGit(branchArgs, cwd);
    if (created.status !== 0) {
      throw new PilotError(`Не удалось создать ветку ${branch}`, {
        hint: created.stderr.trim() || undefined,
        exitCode: 2,
      });
    }

    const status: MaydayRollbackStatus = tests === "fail" ? "failed" : "ready";
    const summary =
      status === "ready"
        ? `[MAYDAY ROLLBACK READY]: откат ${String(list.length)} коммитов в ветке ${branch}.`
        : `[MAYDAY ROLLBACK FAILED]: откат создан, но тесты не проходят (${branch}).`;
    const result: MaydayRollbackResult = {
      status,
      branch,
      to,
      reverted: list.length,
      tests,
      testOutput,
      summary,
      content: "",
    };
    result.content = renderMaydayRollback(result);
    return result;
  } finally {
    shadow.cleanup();
  }
}

export function renderMaydayBisect(result: MaydayBisectResult): string {
  const lines = [
    `Mayday bisect: ${result.status}`,
    `Good: ${result.good.slice(0, 8)}`,
    `Bad: ${result.bad.slice(0, 8)}`,
    `Steps: ${String(result.steps.length)}`,
  ];
  for (const step of result.steps) {
    lines.push(`  [${step.verdict.toUpperCase()}] ${step.sha.slice(0, 8)} ${step.subject}`);
  }
  if (result.firstBad) {
    lines.push(
      "",
      `First bad: ${result.firstBad.sha}`,
      `Subject: ${result.firstBad.subject}`,
      `Author: ${result.firstBad.author} (${result.firstBad.date})`,
      `Diff: ${String(result.firstBad.files)} file(s), +${String(result.firstBad.additions)}/-${String(result.firstBad.deletions)}`,
    );
  }
  lines.push("", result.summary);
  return `${lines.join("\n")}\n`;
}

export function renderMaydayRollback(result: MaydayRollbackResult): string {
  const lines = [
    `Mayday rollback: ${result.status}`,
    `Target: ${result.to.slice(0, 8)}`,
    result.branch ? `Branch: ${result.branch}` : "",
    `Reverted: ${String(result.reverted)}`,
    `Tests: ${result.tests}`,
  ].filter((line) => line.length > 0);
  if (result.testOutput) lines.push("Output:", result.testOutput.trimEnd());
  lines.push("", result.summary);
  return `${lines.join("\n")}\n`;
}
