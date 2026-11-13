import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { PilotError } from "./errors.js";
import { runGit } from "./git.js";

/** Resolves the hooks directory honoring core.hooksPath and worktrees. */
export function resolveHooksDir(cwd: string): string {
  const result = runGit(["rev-parse", "--git-path", "hooks"], cwd);
  if (result.status !== 0) {
    throw new PilotError("не удалось определить каталог git-хуков", {
      hint: result.stderr,
      exitCode: 2,
    });
  }
  const value = result.stdout.trim();
  return isAbsolute(value) ? value : resolve(cwd, value);
}

export interface ResolveHookBinaryOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | undefined {
  const pathValue = env.PATH ?? env.Path;
  if (!pathValue) return undefined;
  const separator = platform === "win32" ? ";" : delimiter;
  const extensions = platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const entry of pathValue.split(separator)) {
    const directory = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return undefined;
}

/**
 * Finds the oc-pilot binary that a managed git hook will use. Mirrors the
 * hook script order: OC_PILOT_BIN, then the project-local binary, then PATH.
 */
export function resolveHookBinary(
  cwd: string,
  options: ResolveHookBinaryOptions = {},
): string | undefined {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const override = env.OC_PILOT_BIN?.trim();
  if (override) {
    const candidate = isAbsolute(override) ? override : resolve(cwd, override);
    if (isExecutableFile(candidate, platform)) return candidate;
    return findOnPath(override, env, platform);
  }

  const local = join(cwd, "node_modules", ".bin", "oc-pilot");
  if (platform === "win32") {
    if (isExecutableFile(`${local}.cmd`, platform)) return `${local}.cmd`;
    if (isExecutableFile(local, platform)) return local;
  } else if (isExecutableFile(local, platform)) {
    return local;
  }
  return findOnPath("oc-pilot", env, platform);
}

export interface VersionInvocation {
  file: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

/**
 * Builds the spawn arguments for `--version`. Windows `.cmd`/`.bat` shims
 * cannot be launched directly, so they go through `cmd.exe`; the command line
 * is passed verbatim to avoid Node's DEP0190 warning for shell + args.
 */
export function versionInvocation(command: string): VersionInvocation {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    return {
      file: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", `"${command}" --version`],
      windowsVerbatimArguments: true,
    };
  }
  return { file: command, args: ["--version"] };
}

/** Runs `--version` for a binary and returns its first output line. */
export function readBinaryVersion(binary: string): string | undefined {
  try {
    const invocation = versionInvocation(binary);
    const result = spawnSync(invocation.file, invocation.args, {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    if (result.status !== 0) return undefined;
    return (result.stdout || result.stderr).trim().split(/\r?\n/)[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Extracts a semantic version from `oc-pilot X.Y.Z` output. */
export function parseBinaryVersion(output: string | undefined): string | undefined {
  if (!output) return undefined;
  const match = /(?:^|\s)v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/.exec(output);
  return match?.[1];
}
