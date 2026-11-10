import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runShellCommand } from "./command.js";
import { splitDiffBlocks, type DiffBlock } from "./diff.js";
import { PilotError } from "./errors.js";
import { runGit } from "./git.js";
import { detectTestCommand } from "./project.js";
import { createShadow } from "./shadow.js";
import { isGeneratedPath, isTestFile } from "./slop/source.js";

export type MitosisStrategy = "file" | "dir" | "type";

export interface MitosisCommit {
  index: number;
  title: string;
  files: string[];
  patch: string;
  additions: number;
  deletions: number;
}

export interface MitosisPlan {
  strategy: MitosisStrategy;
  commits: MitosisCommit[];
  files: number;
  additions: number;
  deletions: number;
  content: string;
}

export interface MitosisOptions {
  strategy?: MitosisStrategy;
  maxFiles?: number;
  prefix?: string;
}

export type MitosisTestStatus = "pass" | "fail" | "skipped";

export interface MitosisAppliedCommit {
  sha: string;
  title: string;
  files: string[];
  tests: MitosisTestStatus;
  output?: string;
  patchFile: string;
}

export interface MitosisApplyResult {
  status: "applied" | "failed";
  branch: string;
  commits: MitosisAppliedCommit[];
  summary: string;
  content: string;
}

export interface MitosisApplyOptions extends MitosisOptions {
  branch?: string;
  force?: boolean;
  testCommand?: string;
  runTests?: boolean;
  timeoutMs?: number;
}

const MAX_OUTPUT = 4_000;
const DEFAULT_MAX_FILES = 20;

function cap(output: string): string {
  return output.length > MAX_OUTPUT ? output.slice(-MAX_OUTPUT) : output;
}

function isDoc(path: string): boolean {
  return /^(?:docs\/|readme|changelog|contributing|license)/i.test(path) || /\.(?:md|mdx|rst)$/i.test(path);
}

function isManifest(path: string): boolean {
  return (
    /(?:^|\/)(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|tsconfig[^/]*\.json|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|requirements[^/]*\.txt|pyproject\.toml|Gemfile|Gemfile\.lock|Dockerfile|Makefile|\.github\/)/i.test(
      path,
    ) || /\.config\.[^/]+$/i.test(path)
  );
}

function typeKey(path: string): "config" | "generated" | "docs" | "tests" | "source" {
  if (isManifest(path)) return "config";
  if (isGeneratedPath(path)) return "generated";
  if (isDoc(path)) return "docs";
  if (isTestFile(path)) return "tests";
  return "source";
}

function dirKey(path: string): string {
  const parts = path.split("/");
  if (parts.length === 1) return `root/${typeKey(path)}`;
  if (parts[0] === "src" && parts.length >= 3) return `src/${parts[1]}`;
  if (parts[0] === "packages" && parts.length >= 3) return `packages/${parts[1]}`;
  return parts[0]!;
}

function statsOf(text: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("+")) additions += 1;
    else if (raw.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

function groupTitle(strategy: MitosisStrategy, key: string, count: number, prefix: string): string {
  if (strategy === "file") return `${prefix}: update ${key}`;
  if (strategy === "type") return `${prefix}: update ${key} (${String(count)} file(s))`;
  return `${prefix}: update ${key} (${String(count)} file(s))`;
}

function groupRank(strategy: MitosisStrategy, key: string): number {
  if (strategy !== "type") return 0;
  return key === "config" ? 0 : key === "source" ? 1 : key === "tests" ? 2 : key === "docs" ? 3 : 4;
}

/** Splits a unified diff into reviewable, independently applicable commits. */
export function buildMitosisPlan(diff: string, options: MitosisOptions = {}): MitosisPlan {
  const strategy = options.strategy ?? "dir";
  const prefix = options.prefix?.trim() || "mitosis";
  const maxFiles = Math.max(1, Math.min(500, options.maxFiles ?? DEFAULT_MAX_FILES));
  const blocks = splitDiffBlocks(diff).filter(
    (block) => block.path !== "(unknown)" && block.path !== "(diff)",
  );

  const groups = new Map<string, { key: string; blocks: typeof blocks }>();
  for (const block of blocks) {
    const key =
      strategy === "file" ? block.path : strategy === "dir" ? dirKey(block.path) : typeKey(block.path);
    const group = groups.get(key) ?? { key, blocks: [] };
    group.blocks.push(block);
    groups.set(key, group);
  }

  const ordered = [...groups.values()].sort(
    (left, right) =>
      groupRank(strategy, left.key) - groupRank(strategy, right.key) ||
      left.key.localeCompare(right.key),
  );

  const commits: MitosisCommit[] = [];
  for (const group of ordered) {
    const sorted = [...group.blocks].sort((left, right) => left.path.localeCompare(right.path));
    const chunks: DiffBlock[][] = [];
    for (let index = 0; index < sorted.length; index += maxFiles) {
      chunks.push(sorted.slice(index, index + maxFiles));
    }
    for (const [chunkIndex, chunk] of chunks.entries()) {
      const files = chunk.map((block) => block.path);
      const patch = chunk.map((block) => block.text).join("\n") + "\n";
      const stats = statsOf(patch);
      const baseTitle = groupTitle(strategy, group.key, chunk.length, prefix);
      const title = chunks.length > 1 ? `${baseTitle} [${String(chunkIndex + 1)}/${String(chunks.length)}]` : baseTitle;
      commits.push({
        index: commits.length + 1,
        title,
        files,
        patch,
        additions: stats.additions,
        deletions: stats.deletions,
      });
    }
  }

  const plan: MitosisPlan = {
    strategy,
    commits,
    files: blocks.length,
    additions: commits.reduce((sum, commit) => sum + commit.additions, 0),
    deletions: commits.reduce((sum, commit) => sum + commit.deletions, 0),
    content: "",
  };
  plan.content = renderMitosisPlan(plan);
  return plan;
}

export function renderMitosisPlan(plan: MitosisPlan): string {
  const lines = [
    `Mitosis plan: ${String(plan.commits.length)} commit(s), ${String(plan.files)} file(s), +${String(plan.additions)}/-${String(plan.deletions)}`,
    `Strategy: ${plan.strategy}`,
    "",
  ];
  for (const commit of plan.commits) {
    lines.push(
      `${String(commit.index)}. ${commit.title} (${String(commit.files.length)} file(s), +${String(commit.additions)}/-${String(commit.deletions)})`,
    );
    for (const file of commit.files) lines.push(`   ${file}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderMitosisPlanMarkdown(plan: MitosisPlan): string {
  const lines = [
    "## oc-pilot mitosis plan",
    "",
    `- **Commits:** ${String(plan.commits.length)}`,
    `- **Files:** ${String(plan.files)}`,
    `- **Changes:** +${String(plan.additions)}/-${String(plan.deletions)}`,
    `- **Strategy:** ${plan.strategy}`,
    "",
  ];
  for (const commit of plan.commits) {
    lines.push(`### ${String(commit.index)}. ${commit.title}`, "");
    lines.push(`+${String(commit.additions)}/-${String(commit.deletions)}`, "");
    for (const file of commit.files) lines.push(`- \`${file}\``);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "commit"
  );
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

function branchExists(cwd: string, branch: string): boolean {
  return runGit(["rev-parse", "--verify", `refs/heads/${branch}`], cwd).status === 0;
}

/** Applies the plan as a sequence of commits in a shadow worktree and exposes a branch. */
export async function applyMitosis(
  cwd: string,
  diff: string,
  options: MitosisApplyOptions = {},
): Promise<MitosisApplyResult> {
  const plan = buildMitosisPlan(diff, options);
  const branch = options.branch?.trim() || `oc-pilot/mitosis-${timestamp()}`;
  if (branchExists(cwd, branch) && !options.force) {
    throw new PilotError(`Ветка уже существует: ${branch}`, {
      hint: "Укажите другую --branch или добавьте --force.",
      exitCode: 2,
    });
  }

  const testCommand = options.testCommand?.trim() || detectTestCommand(cwd)?.command;
  const runTests = options.runTests !== false && Boolean(testCommand);
  const timeoutMs = Math.max(1_000, Math.min(1_800_000, options.timeoutMs ?? 300_000));
  const shadow = createShadow(cwd, "mitosis-worktree", "HEAD");
  const patchDir = join(cwd, ".oc-pilot", "mitosis");
  mkdirSync(patchDir, { recursive: true });

  const applied: MitosisAppliedCommit[] = [];
  try {
    for (const commit of plan.commits) {
      const patchFile = join(patchDir, `${String(commit.index).padStart(2, "0")}-${slug(commit.title)}.patch`);
      writeFileSync(patchFile, commit.patch, "utf8");

      const check = runGit(["apply", "--check", patchFile], shadow.dir);
      if (check.status !== 0) {
        throw new PilotError(`Патч ${String(commit.index)} не применился`, {
          hint: check.stderr.trim() || check.stdout.trim() || undefined,
          exitCode: 2,
        });
      }
      const apply = runGit(["apply", patchFile], shadow.dir);
      if (apply.status !== 0) {
        throw new PilotError(`Не удалось применить патч ${String(commit.index)}`, {
          hint: apply.stderr.trim() || apply.stdout.trim() || undefined,
          exitCode: 2,
        });
      }
      runGit(["add", "-A"], shadow.dir);
      const result = runGit(["commit", "-m", commit.title], shadow.dir);
      if (result.status !== 0) {
        throw new PilotError("Не удалось создать коммит в shadow worktree", {
          hint: result.stderr.trim() || "Проверьте git user.name и user.email.",
          exitCode: 2,
        });
      }
      const sha = runGit(["rev-parse", "HEAD"], shadow.dir).stdout.trim();

      let tests: MitosisTestStatus = "skipped";
      let output: string | undefined;
      if (runTests && testCommand) {
        const run = await runShellCommand(testCommand, shadow.dir, { timeoutMs });
        tests = run.exitCode === 0 && !run.timedOut ? "pass" : "fail";
        output = cap(run.output);
      }
      applied.push({ sha, title: commit.title, files: commit.files, tests, output, patchFile });
      if (tests === "fail") break;
    }

    const last = applied[applied.length - 1];
    if (last) {
      const branchArgs = options.force
        ? ["branch", "-f", branch, last.sha]
        : ["branch", branch, last.sha];
      const branchResult = runGit(branchArgs, cwd);
      if (branchResult.status !== 0) {
        throw new PilotError(`Не удалось создать ветку ${branch}`, {
          hint: branchResult.stderr.trim() || undefined,
          exitCode: 2,
        });
      }
    }

    const failed = applied.some((commit) => commit.tests === "fail");
    const status = failed ? "failed" : "applied";
    const summary = failed
      ? `[MITOSIS FAILED]: тесты упали на коммите ${String(applied.findIndex((commit) => commit.tests === "fail") + 1)} из ${String(plan.commits.length)}.`
      : `[MITOSIS APPLIED]: ${String(applied.length)} коммитов в ветке ${branch}.`;
    const lines = [
      `Mitosis: ${status}`,
      `Branch: ${branch}`,
      `Commits: ${String(applied.length)} из ${String(plan.commits.length)}`,
      runTests ? `Tests: ${testCommand}` : "Tests: skipped",
    ];
    for (const commit of applied) {
      lines.push(`  ${commit.sha.slice(0, 8)} [${commit.tests}] ${commit.title}`);
      if (commit.tests === "fail" && commit.output) lines.push(`    ${commit.output.trimEnd()}`);
    }
    lines.push("", summary);
    return {
      status,
      branch,
      commits: applied,
      summary,
      content: `${lines.join("\n")}\n`,
    };
  } finally {
    shadow.cleanup();
  }
}
