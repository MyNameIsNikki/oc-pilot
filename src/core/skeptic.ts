import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runShellCommand } from "./command.js";
import { PilotError } from "./errors.js";
import { runGit } from "./git.js";
import { createShadow, writeShadowDiff } from "./shadow.js";

export interface SkepticHypothesis {
  test: string;
  reason: string;
}

export type SkepticStatus = "clean" | "bug" | "unfalsifiable" | "error";

export interface SkepticReport {
  source: string;
  status: SkepticStatus;
  summary: string;
  hypothesis?: SkepticHypothesis;
  testFile?: string;
  testOutput?: string;
  durationMs: number;
}

export interface SkepticOptions {
  command?: string;
  timeoutMs?: number;
}

const TEST_FILE = ".oc-pilot/skeptic.test.mjs";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 6_000;

function cap(output: string): string {
  return output.length > MAX_OUTPUT ? output.slice(-MAX_OUTPUT) : output;
}

export function parseSkepticHypothesis(text: string): SkepticHypothesis | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  const test = typeof record.test === "string" ? record.test.trim() : "";
  const reason = typeof record.reason === "string" ? record.reason.trim() : "";
  if (!test || !reason) return undefined;
  return { test, reason };
}

export function buildSkepticPrompt(diff: string, context?: string): string {
  return [
    "You are a skeptic. A diff is proposed, and your job is to falsify it with one executable test.",
    "Write a minimal self-contained ESM test for Node.js 22 using node:test and node:assert/strict.",
    "The test will be written to .oc-pilot/skeptic.test.mjs inside a git worktree where the diff is applied.",
    "It must fail because of the diff and pass on the unmodified HEAD. Import project files with relative paths.",
    "If the project is TypeScript, import a built dist file or assert on source text; do not assume a transpiler.",
    "No new dependencies, no network, no writes outside the test, one focused test.",
    context ? `Extra context from the author:\n${context}` : "",
    "Return strict JSON only, with no markdown and no prose outside the object:",
    '{"test":"import test from \\"node:test\\";\\nimport assert from \\"node:assert/strict\\";\\n...","reason":"why this test fails on the diff"}',
    "If you cannot write a test that distinguishes the diff from HEAD, return an empty test and explain why.",
    "",
    "DIFF:",
    diff,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

export function renderSkeptic(report: SkepticReport): string {
  const lines = [`Skeptic: ${report.status}`, `Source: ${report.source}`];
  if (report.hypothesis) lines.push(`Hypothesis: ${report.hypothesis.reason}`);
  if (report.testFile) lines.push(`Test: ${report.testFile}`);
  if (report.testOutput) {
    lines.push("Output:");
    lines.push(report.testOutput.trimEnd());
  }
  lines.push(report.summary);
  return `${lines.join("\n")}\n`;
}

function testCommand(command: string | undefined, testFile: string): string {
  const template = command?.trim() || "node --test {file}";
  return template.includes("{file}") ? template.replace("{file}", testFile) : `${template} ${testFile}`;
}

function looksBroken(output: string): boolean {
  return /ERR_MODULE_NOT_FOUND|Cannot find module|ERR_UNKNOWN_FILE_EXTENSION|SyntaxError:/.test(output);
}

function writeTest(shadowDir: string, hypothesis: SkepticHypothesis): void {
  const dir = join(shadowDir, ".oc-pilot");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(shadowDir, TEST_FILE), `${hypothesis.test.trimEnd()}\n`, "utf8");
}

function applyDiff(shadowDir: string, patch: string): string | undefined {
  const check = runGit(["apply", "--check", patch], shadowDir);
  if (check.status !== 0) return check.stderr.trim() || check.stdout.trim() || "git apply --check failed";
  const apply = runGit(["apply", patch], shadowDir);
  if (apply.status !== 0) return apply.stderr.trim() || apply.stdout.trim() || "git apply failed";
  return undefined;
}

/** Runs the generated test on the diff and then on clean HEAD to prove it discriminates. */
export async function runSkeptic(
  cwd: string,
  diff: string,
  hypothesis: SkepticHypothesis,
  options: SkepticOptions = {},
): Promise<SkepticReport> {
  const started = Date.now();
  const timeoutMs = Math.max(1_000, Math.min(600_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const command = testCommand(options.command, TEST_FILE);
  const temp = writeShadowDiff(diff);
  const diffShadow = createShadow(cwd);
  let diffOutput = "";
  try {
    const applyError = applyDiff(diffShadow.dir, temp.path);
    if (applyError) {
      return {
        source: "diff",
        status: "error",
        summary: `[SKEPTIC ERROR]: diff не применился в shadow worktree: ${applyError}`,
        hypothesis,
        durationMs: Date.now() - started,
      };
    }
    writeTest(diffShadow.dir, hypothesis);
    const run = await runShellCommand(command, diffShadow.dir, { timeoutMs });
    diffOutput = run.output;
    if (run.timedOut) {
      return {
        source: "diff",
        status: "error",
        summary: `[SKEPTIC ERROR]: тест не завершился за ${String(timeoutMs)} мс.`,
        hypothesis,
        testFile: TEST_FILE,
        testOutput: cap(diffOutput),
        durationMs: Date.now() - started,
      };
    }
    if (run.exitCode === 0) {
      return {
        source: "diff",
        status: "clean",
        summary: "[SKEPTIC CLEAN]: предложенный тест проходит на diff, гипотеза не подтверждена.",
        hypothesis,
        testFile: TEST_FILE,
        testOutput: cap(diffOutput),
        durationMs: Date.now() - started,
      };
    }
    if (looksBroken(diffOutput)) {
      return {
        source: "diff",
        status: "error",
        summary: "[SKEPTIC ERROR]: сгенерированный тест не запустился.",
        hypothesis,
        testFile: TEST_FILE,
        testOutput: cap(diffOutput),
        durationMs: Date.now() - started,
      };
    }
  } finally {
    diffShadow.cleanup();
    temp.cleanup();
  }

  const cleanShadow = createShadow(cwd);
  try {
    writeTest(cleanShadow.dir, hypothesis);
    const clean = await runShellCommand(command, cleanShadow.dir, { timeoutMs });
    if (clean.timedOut) {
      return {
        source: "diff",
        status: "error",
        summary: `[SKEPTIC ERROR]: тест на HEAD не завершился за ${String(timeoutMs)} мс.`,
        hypothesis,
        testFile: TEST_FILE,
        testOutput: cap(clean.output),
        durationMs: Date.now() - started,
      };
    }
    if (clean.exitCode === 0) {
      return {
        source: "diff",
        status: "bug",
        summary: "[SKEPTIC BUG]: тест падает на diff и проходит на HEAD. Гипотеза подтверждена.",
        hypothesis,
        testFile: TEST_FILE,
        testOutput: cap(diffOutput),
        durationMs: Date.now() - started,
      };
    }
    if (looksBroken(clean.output)) {
      return {
        source: "diff",
        status: "error",
        summary: "[SKEPTIC ERROR]: сгенерированный тест не запустился на HEAD.",
        hypothesis,
        testFile: TEST_FILE,
        testOutput: cap(clean.output),
        durationMs: Date.now() - started,
      };
    }
    return {
      source: "diff",
      status: "unfalsifiable",
      summary: "[SKEPTIC UNFALSIFIABLE]: тест падает и на diff, и на HEAD, поэтому не доказывает дефект.",
      hypothesis,
      testFile: TEST_FILE,
      testOutput: cap(diffOutput),
      durationMs: Date.now() - started,
    };
  } finally {
    cleanShadow.cleanup();
  }
}

export function parseSkepticTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const match = /^(\d+(?:\.\d+)?)(ms|s)?$/i.exec(raw.trim());
  if (!match?.[1]) {
    throw new PilotError(`Некорректный таймаут: ${raw}`, {
      hint: "Используйте 120s, 500ms или миллисекунды.",
      exitCode: 2,
    });
  }
  const value = Number(match[1]);
  return Math.round(match[2]?.toLowerCase() === "ms" ? value : value * 1000);
}
