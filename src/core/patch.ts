import { spawn } from "node:child_process";
import { parseGitPath } from "./diff.js";

export interface GitApplyResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function extractPatch(text: string): string | undefined {
  const fences = [...text.matchAll(/```(?:diff|patch)?[ \t]*\r?\n([\s\S]*?)```/gi)];
  for (const match of fences) {
    const candidate = (match[1] ?? "").trim();
    if (looksLikePatch(candidate)) return candidate;
  }

  const solution = text.search(/^####\s+(?:Решение|Solution)/m);
  if (solution !== -1) {
    const tail = text.slice(solution);
    const start = tail.search(/^(?:diff --git|---\s)/m);
    if (start !== -1) {
      const candidate = stripFenceTail(tail.slice(start));
      if (looksLikePatch(candidate)) return candidate;
    }
  }

  const first = text.search(/^(?:diff --git|---\s)/m);
  if (first !== -1) {
    const candidate = stripFenceTail(text.slice(first));
    if (looksLikePatch(candidate)) return candidate;
  }
  return undefined;
}

function stripFenceTail(text: string): string {
  const fence = text.indexOf("```");
  return (fence === -1 ? text : text.slice(0, fence)).trim();
}

function looksLikePatch(text: string): boolean {
  return /^diff --git\s/m.test(text) || (/^---\s+\S/m.test(text) && /^\+\+\+\s+\S/m.test(text));
}

function splitGitHeaderPaths(rest: string): string[] {
  const paths: string[] = [];
  let index = 0;
  while (index < rest.length) {
    while (rest[index] === " " || rest[index] === "\t") index += 1;
    if (index >= rest.length) break;
    const start = index;
    if (rest[index] === '"') {
      index += 1;
      while (index < rest.length) {
        if (rest[index] === "\\") {
          index += 2;
          continue;
        }
        if (rest[index] === '"') {
          index += 1;
          break;
        }
        index += 1;
      }
      paths.push(rest.slice(start, index));
    } else {
      while (index < rest.length && rest[index] !== " " && rest[index] !== "\t") index += 1;
      paths.push(rest.slice(start, index));
    }
  }
  return paths;
}

/**
 * Files a patch would modify. Reads both sides of file headers and `diff --git`
 * lines, so deletions and binary patches cannot escape the reviewed file set.
 */
export function patchTargets(patch: string): string[] {
  const targets = new Set<string>();
  const add = (raw: string): void => {
    if (!raw.trim()) return;
    const path = parseGitPath(raw);
    if (path && path !== "/dev/null") targets.add(path);
  };

  let inHunk = false;
  let oldRemain = 0;
  let newRemain = 0;

  for (const line of patch.split(/\r?\n/)) {
    if (inHunk && oldRemain <= 0 && newRemain <= 0) inHunk = false;
    if (inHunk) {
      if (line.startsWith("\\")) continue;
      if (line.startsWith("+")) {
        newRemain -= 1;
        continue;
      }
      if (line.startsWith("-")) {
        oldRemain -= 1;
        continue;
      }
      if (line.startsWith(" ")) {
        oldRemain -= 1;
        newRemain -= 1;
        continue;
      }
      inHunk = false;
    }

    if (line.startsWith("diff --git ")) {
      for (const path of splitGitHeaderPaths(line.slice("diff --git ".length))) add(path);
      continue;
    }
    if (line.startsWith("@@")) {
      const match = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      if (match) {
        oldRemain = match[1] === undefined ? 1 : Number(match[1]);
        newRemain = match[2] === undefined ? 1 : Number(match[2]);
        inHunk = true;
      }
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ")) add(line.slice(4));
  }
  return [...targets];
}

function runGitApply(cwd: string, patch: string, args: string[]): Promise<GitApplyResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["apply", "--whitespace=nowarn", ...args], {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => resolvePromise({ exitCode: code ?? 1, stdout, stderr }));
    child.stdin.end(patch.endsWith("\n") ? patch : `${patch}\n`);
  });
}

export function checkPatch(cwd: string, patch: string): Promise<GitApplyResult> {
  return runGitApply(cwd, patch, ["--check"]);
}

export function applyPatch(cwd: string, patch: string): Promise<GitApplyResult> {
  return runGitApply(cwd, patch, []);
}

export function revertPatch(cwd: string, patch: string): Promise<GitApplyResult> {
  return runGitApply(cwd, patch, ["-R"]);
}
