import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runShellCommand } from "./command.js";
import { PilotError } from "./errors.js";
import { runGit } from "./git.js";
import { createShadow } from "./shadow.js";
import type { SkepticHypothesis } from "./skeptic.js";

export type VaccineHypothesis = SkepticHypothesis;

export type VaccineVerificationStatus = "verified" | "rejected" | "error";

export interface VaccineVerification {
  status: VaccineVerificationStatus;
  summary: string;
  bugOutput?: string;
  fixOutput?: string;
  durationMs: number;
}

export interface VaccineOptions {
  command?: string;
  timeoutMs?: number;
}

export interface VaccineRecord {
  id: string;
  createdAt: string;
  bug: string;
  fix: string;
  testFile: string;
  command: string;
  reason: string;
}

export interface VaccineStore {
  version: 1;
  vaccines: VaccineRecord[];
}

export type VaccineRunStatus = "pass" | "fail" | "error";

export interface VaccineRunResult {
  id: string;
  status: VaccineRunStatus;
  output: string;
}

export interface VaccineRunReport {
  total: number;
  passed: number;
  failed: number;
  results: VaccineRunResult[];
  summary: string;
  content: string;
}

export const VACCINE_STORE = ".oc-pilot/vaccines.json";
export const VACCINE_DIR = ".oc-pilot/vaccines";
const STORE_VERSION = 1;
const TEST_FILE = ".oc-pilot/vaccine.test.mjs";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 4_000;

function cap(output: string): string {
  return output.length > MAX_OUTPUT ? output.slice(-MAX_OUTPUT) : output;
}

function looksBroken(output: string): boolean {
  return /ERR_MODULE_NOT_FOUND|Cannot find module|ERR_UNKNOWN_FILE_EXTENSION|SyntaxError:/.test(output);
}

function testCommand(command: string | undefined, file: string): string {
  const template = command?.trim() || "node --test {file}";
  return template.includes("{file}") ? template.replace("{file}", file) : `${template} ${file}`;
}

function writeTest(dir: string, test: string): void {
  mkdirSync(join(dir, ".oc-pilot"), { recursive: true });
  writeFileSync(join(dir, TEST_FILE), `${test.trimEnd()}\n`, "utf8");
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

export function buildVaccinePrompt(
  fixDiff: string,
  bugRef: string,
  fixRef: string,
  context?: string,
): string {
  return [
    "You are creating a vaccine for a historical bug fix: one minimal test that would have caught the bug.",
    "Write a self-contained ESM test for Node.js 22 using node:test and node:assert/strict.",
    `The test will be written to ${TEST_FILE} and run in two git worktrees: the buggy parent (${bugRef}) and the fixed commit (${fixRef}).`,
    "It must FAIL on the buggy parent and PASS on the fixed commit. If it cannot distinguish the two, return an empty test and explain why.",
    "Import project files with relative paths. If the project is TypeScript, import a built dist file or assert on source text; do not assume a transpiler.",
    "No new dependencies, no network, no writes outside the test, one focused test.",
    context ? `Extra context from the author:\n${context}` : "",
    "Return strict JSON only, with no markdown and no prose outside the object:",
    '{"test":"import test from \\"node:test\\";\\nimport assert from \\"node:assert/strict\\";\\n...","reason":"which bug this test locks in"}',
    "",
    "FIX DIFF:",
    fixDiff,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

/** Proves that the test fails on the buggy parent and passes on the fixed commit. */
export async function verifyVaccine(
  cwd: string,
  bugRef: string,
  fixRef: string,
  hypothesis: VaccineHypothesis,
  options: VaccineOptions = {},
): Promise<VaccineVerification> {
  const started = Date.now();
  const bugCommit = resolveCommit(cwd, bugRef);
  const fixCommit = resolveCommit(cwd, fixRef);
  if (bugCommit === fixCommit) {
    throw new PilotError("bug и fix указывают на один коммит", { exitCode: 2 });
  }

  const timeoutMs = Math.max(1_000, Math.min(600_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const command = testCommand(options.command, TEST_FILE);
  const bug = createShadow(cwd, "vaccine-bug", bugCommit);
  const fix = createShadow(cwd, "vaccine-fix", fixCommit);

  try {
    writeTest(bug.dir, hypothesis.test);
    const bugRun = await runShellCommand(command, bug.dir, { timeoutMs });
    if (bugRun.timedOut) {
      return {
        status: "error",
        summary: `[VACCINE ERROR]: тест не завершился на баге за ${String(timeoutMs)} мс.`,
        bugOutput: cap(bugRun.output),
        durationMs: Date.now() - started,
      };
    }
    if (bugRun.exitCode === 0) {
      return {
        status: "rejected",
        summary: "[VACCINE REJECTED]: тест проходит на баге и ничего не ловит.",
        bugOutput: cap(bugRun.output),
        durationMs: Date.now() - started,
      };
    }
    if (looksBroken(bugRun.output)) {
      return {
        status: "error",
        summary: "[VACCINE ERROR]: сгенерированный тест не запустился на баге.",
        bugOutput: cap(bugRun.output),
        durationMs: Date.now() - started,
      };
    }

    writeTest(fix.dir, hypothesis.test);
    const fixRun = await runShellCommand(command, fix.dir, { timeoutMs });
    if (fixRun.timedOut) {
      return {
        status: "error",
        summary: `[VACCINE ERROR]: тест не завершился на исправлении за ${String(timeoutMs)} мс.`,
        bugOutput: cap(bugRun.output),
        fixOutput: cap(fixRun.output),
        durationMs: Date.now() - started,
      };
    }
    if (fixRun.exitCode !== 0) {
      return {
        status: "rejected",
        summary: "[VACCINE REJECTED]: тест падает и на исправленном коммите.",
        bugOutput: cap(bugRun.output),
        fixOutput: cap(fixRun.output),
        durationMs: Date.now() - started,
      };
    }
    if (looksBroken(fixRun.output)) {
      return {
        status: "error",
        summary: "[VACCINE ERROR]: сгенерированный тест не запустился на исправлении.",
        bugOutput: cap(bugRun.output),
        fixOutput: cap(fixRun.output),
        durationMs: Date.now() - started,
      };
    }

    return {
      status: "verified",
      summary: "[VACCINE VERIFIED]: тест падает на баге и проходит на исправлении.",
      bugOutput: cap(bugRun.output),
      fixOutput: cap(fixRun.output),
      durationMs: Date.now() - started,
    };
  } finally {
    bug.cleanup();
    fix.cleanup();
  }
}

function vaccineId(bug: string, fix: string, test: string): string {
  return `vac_${createHash("sha256").update(`${bug}:${fix}:${test}`).digest("hex").slice(0, 16)}`;
}

function emptyStore(): VaccineStore {
  return { version: STORE_VERSION, vaccines: [] };
}

export function vaccineStorePath(cwd: string): string {
  return join(cwd, ".oc-pilot", "vaccines.json");
}

export function readVaccineStore(cwd: string): VaccineStore {
  const path = vaccineStorePath(cwd);
  if (!existsSync(path)) return emptyStore();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<VaccineStore>;
    if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.vaccines)) return emptyStore();
    const vaccines = parsed.vaccines.filter((item): item is VaccineRecord => {
      if (!item || typeof item !== "object") return false;
      const record = item as Partial<VaccineRecord>;
      return (
        typeof record.id === "string" &&
        typeof record.createdAt === "string" &&
        typeof record.bug === "string" &&
        typeof record.fix === "string" &&
        typeof record.testFile === "string" &&
        typeof record.command === "string" &&
        typeof record.reason === "string"
      );
    });
    return { version: STORE_VERSION, vaccines };
  } catch {
    return emptyStore();
  }
}

function writeVaccineStore(cwd: string, store: VaccineStore): void {
  const path = vaccineStorePath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

/** Stores a verified vaccine and its test file. */
export function storeVaccine(
  cwd: string,
  input: { bug: string; fix: string; command: string; reason: string; test: string },
): VaccineRecord {
  const id = vaccineId(input.bug, input.fix, input.test);
  const testFile = `${VACCINE_DIR}/${id}.test.mjs`;
  const store = readVaccineStore(cwd);
  const existing = store.vaccines.find((record) => record.id === id);
  if (existing) return existing;

  mkdirSync(join(cwd, VACCINE_DIR), { recursive: true });
  writeFileSync(join(cwd, testFile), `${input.test.trimEnd()}\n`, "utf8");

  const record: VaccineRecord = {
    id,
    createdAt: new Date().toISOString(),
    bug: input.bug,
    fix: input.fix,
    testFile,
    command: input.command,
    reason: input.reason,
  };
  writeVaccineStore(cwd, { version: STORE_VERSION, vaccines: [...store.vaccines, record] });
  return record;
}

export function listVaccines(cwd: string): { vaccines: VaccineRecord[]; content: string } {
  const vaccines = readVaccineStore(cwd).vaccines;
  const lines = [`Vaccines: ${String(vaccines.length)}.`];
  if (vaccines.length === 0) lines.push("Вакцин нет. Сначала выполните oc-pilot vaccine create.");
  for (const vaccine of vaccines) {
    lines.push(`${vaccine.id} bug=${vaccine.bug.slice(0, 8)} fix=${vaccine.fix.slice(0, 8)} ${vaccine.reason}`);
  }
  return { vaccines, content: `${lines.join("\n")}\n` };
}

export function forgetVaccine(cwd: string, id: string): { removed: boolean; remaining: number } {
  const store = readVaccineStore(cwd);
  const target = store.vaccines.find((record) => record.id === id);
  if (!target) return { removed: false, remaining: store.vaccines.length };
  rmSync(join(cwd, target.testFile), { force: true });
  const next = store.vaccines.filter((record) => record.id !== id);
  writeVaccineStore(cwd, { version: STORE_VERSION, vaccines: next });
  return { removed: true, remaining: next.length };
}

export function clearVaccines(cwd: string): { removed: number } {
  const store = readVaccineStore(cwd);
  rmSync(vaccineStorePath(cwd), { force: true });
  rmSync(join(cwd, VACCINE_DIR), { recursive: true, force: true });
  return { removed: store.vaccines.length };
}

/** Runs every stored vaccine against the current HEAD in one shadow worktree. */
export async function runVaccines(cwd: string, options: VaccineOptions = {}): Promise<VaccineRunReport> {
  const store = readVaccineStore(cwd);
  if (store.vaccines.length === 0) {
    const summary = "[VACCINES EMPTY]: сохранённых вакцин нет.";
    return {
      total: 0,
      passed: 0,
      failed: 0,
      results: [],
      summary,
      content: `${summary}\n`,
    };
  }

  const timeoutMs = Math.max(1_000, Math.min(600_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const shadow = createShadow(cwd, "vaccine-run", "HEAD");
  try {
    const results: VaccineRunResult[] = [];
    for (const vaccine of store.vaccines) {
      const sourcePath = join(cwd, vaccine.testFile);
      if (!existsSync(sourcePath)) {
        results.push({ id: vaccine.id, status: "error", output: `missing ${vaccine.testFile}` });
        continue;
      }
      const test = readFileSync(sourcePath, "utf8");
      writeTest(shadow.dir, test);
      const command = testCommand(options.command ?? vaccine.command, TEST_FILE);
      const run = await runShellCommand(command, shadow.dir, { timeoutMs });
      const status: VaccineRunStatus = run.timedOut ? "error" : run.exitCode === 0 ? "pass" : "fail";
      results.push({ id: vaccine.id, status, output: cap(run.output) });
    }

    const passed = results.filter((result) => result.status === "pass").length;
    const failed = results.length - passed;
    const summary =
      failed === 0
        ? `[VACCINES PASSED]: ${String(passed)} из ${String(results.length)} вакцин проходят.`
        : `[VACCINE FAILED]: ${String(failed)} из ${String(results.length)} вакцин не проходят.`;
    const lines = [`Vaccines: ${String(results.length)}, passed ${String(passed)}, failed ${String(failed)}`];
    for (const result of results) {
      lines.push(`  [${result.status.toUpperCase()}] ${result.id}`);
      if (result.status !== "pass") lines.push(`    ${cap(result.output).trimEnd()}`);
    }
    lines.push("", summary);
    return {
      total: results.length,
      passed,
      failed,
      results,
      summary,
      content: `${lines.join("\n")}\n`,
    };
  } finally {
    shadow.cleanup();
  }
}

export function renderVaccineVerification(verification: VaccineVerification): string {
  const lines = [`Vaccine: ${verification.status}`, verification.summary];
  if (verification.bugOutput) lines.push("Bug output:", verification.bugOutput.trimEnd());
  if (verification.fixOutput) lines.push("Fix output:", verification.fixOutput.trimEnd());
  return `${lines.join("\n")}\n`;
}
