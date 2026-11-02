import { resolve } from "node:path";
import type { CommandContext, DiffStats, SecretFinding } from "../types.js";
import { collectChangedFiles, collectDiffStats } from "./diff.js";
import { PilotError } from "./errors.js";
import { collectGitDiff } from "./git.js";
import { readStdin, readTextFile } from "./io.js";
import { log } from "./log.js";
import { asBoolean, asString, type ArgsValues } from "./parse.js";
import { scanDiff } from "./secrets.js";

export interface DiffData {
  /** Original diff. */
  diff: string;
  /** Diff prepared for the model (secrets may be redacted). */
  payloadDiff: string;
  findings: SecretFinding[];
  changedFiles: string[];
  untracked: string[];
  source: string;
  stats: DiffStats;
}

export interface LoadDiffOptions {
  optionalGit?: boolean;
}

/**
 * Human/model-facing source label. The diff content is always embedded in
 * GIT_DIFF, so the label must not look like a file the model should read.
 */
export function describeDiffSource(source: string): string {
  if (source === "без diff") return source;
  const origin = source === "stdin" ? "stdin" : source.startsWith("git ") ? source : "diff-файл";
  return `${origin} (содержимое уже включено в GIT_DIFF)`;
}

const GIT_ONLY_FLAGS = ["staged", "unstaged", "base", "include-untracked"] as const;

export async function loadDiff(
  values: ArgsValues,
  ctx: CommandContext,
  paths: string[] = [],
  options: LoadDiffOptions = {},
): Promise<DiffData> {
  const diffFile = asString(values, "diff");
  const useStdin = asBoolean(values, "stdin");
  const gitFlagsUsed = GIT_ONLY_FLAGS.filter((flag) => asBoolean(values, flag));

  if (diffFile !== undefined && useStdin) {
    throw new PilotError("--diff и --stdin нельзя использовать одновременно", { exitCode: 2 });
  }
  if ((diffFile !== undefined || useStdin) && gitFlagsUsed.length > 0) {
    throw new PilotError(`--diff/--stdin нельзя комбинировать с --${gitFlagsUsed[0]}`, { exitCode: 2 });
  }

  let rawDiff = "";
  let source = "";
  let untracked: string[] = [];

  if (diffFile !== undefined) {
    rawDiff = diffFile === "-" ? await readStdin() : readTextFile(resolve(ctx.cwd, diffFile), "diff-файл");
    source = diffFile === "-" ? "stdin" : diffFile;
  } else if (useStdin) {
    rawDiff = await readStdin();
    source = "stdin";
  } else {
    if (asBoolean(values, "staged") && asBoolean(values, "unstaged")) {
      throw new PilotError("Выберите один режим: --staged или --unstaged", { exitCode: 2 });
    }

    try {
      const result = collectGitDiff({
        cwd: ctx.cwd,
        staged: asBoolean(values, "staged"),
        unstaged: asBoolean(values, "unstaged"),
        base: asString(values, "base"),
        includeUntracked: asBoolean(values, "include-untracked"),
        paths,
      });
      rawDiff = result.diff;
      untracked = result.untracked;

      const base = asString(values, "base");
      if (base) source = `git diff ${base}...HEAD`;
      else if (asBoolean(values, "staged")) source = "git diff --cached";
      else if (asBoolean(values, "unstaged")) source = "git diff";
      else source = "git diff HEAD";
      if (asBoolean(values, "include-untracked")) source += " + untracked";
    } catch (error) {
      if (options.optionalGit && error instanceof PilotError && /git-репозиторием/.test(error.message)) {
        log.detail("git-репозиторий не найден — diff пропущен.");
        rawDiff = "";
        source = "без diff";
      } else {
        throw error;
      }
    }
  }

  if (paths.length > 0 && (diffFile !== undefined || useStdin)) {
    throw new PilotError("Позиционные пути применяются только к git diff", { exitCode: 2 });
  }

  const changedFiles = collectChangedFiles(rawDiff);
  const stats = collectDiffStats(rawDiff);
  const scanDisabled = asBoolean(values, "no-secret-scan");
  const scan = scanDisabled ? { findings: [], redacted: rawDiff } : scanDiff(rawDiff);
  if (scanDisabled) log.warn("Сканирование секретов отключено (--no-secret-scan).");

  return {
    diff: rawDiff,
    payloadDiff: ctx.config.redactSecrets ? scan.redacted : rawDiff,
    findings: scan.findings,
    changedFiles,
    untracked,
    source,
    stats,
  };
}
