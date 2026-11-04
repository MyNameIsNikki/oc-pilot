#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./core/config.js";
import { runGit } from "./core/git.js";
import { SYSTEM_PROMPT_EN, SYSTEM_PROMPT_RU } from "./core/prompt.js";
import { loadRules } from "./core/rules.js";
import { loadSecretIgnore, scanDiff, scanText } from "./core/secrets.js";
import { patchTargets } from "./core/patch.js";
import { VERSION } from "./version.js";

const SERVER_NAME = "oc-pilot";
const PROTOCOL_VERSION = "2025-06-18";
const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), "cli.js");

/** Model-backed calls allowed per process; 0 disables the limit. */
let maxToolCalls = 50;
let toolCallsUsed = 0;
/** Offline tools never spend the budget and always work. */
const OFFLINE_TOOLS = new Set(["scan", "stats", "slop"]);
/** Set only over stdio, where a notification channel exists. */
let emitNotification: ((message: JsonObject) => void) | undefined;
let logLevel: string | undefined;

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

type JsonObject = Record<string, unknown>;

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: JsonObject;
  isError?: boolean;
  _meta?: JsonObject;
}

/**
 * Shared output knobs. Every tool can cap the findings array and ask for a
 * compact summary instead of the full JSON echo.
 */
const RESULT_PROPERTIES = {
  max_findings: {
    type: "integer",
    minimum: 1,
    description: "Cap the findings array (default 50); a capped result also carries truncated and totalFindings",
  },
  verbosity: {
    type: "string",
    enum: ["full", "compact"],
    description: "full returns the JSON payload, compact returns a one-line summary and keeps structuredContent",
  },
} as const;

const TOOLS = [
  {
    name: "review",
    description:
      "Review a git diff (or a supplied unified diff) for bugs, security issues and language idioms. Returns the Markdown review and structured findings as JSON.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "Optional pathspecs, e.g. src/ or wallet.go" },
        ...RESULT_PROPERTIES,
        diff: { type: "string", description: "Unified diff text. Omit to use the project's git diff." },
        base: { type: "string", description: "Review base...HEAD, e.g. main" },
        staged: { type: "boolean", description: "Only staged changes" },
        unstaged: { type: "boolean", description: "Only unstaged changes" },
        include_untracked: { type: "boolean", description: "Include untracked files" },
        context: { type: "string", description: "Extra context for the model" },
        fail_on: { type: "string", enum: ["none", "critical", "warning", "style"], description: "Exit policy for findings" },
        lang: { type: "string", enum: ["en", "ru"], description: "Model-facing prompt language" },
        model: { type: "string", description: "OpenCode model id, provider/model" },
        timeout: { type: "integer", minimum: 1, description: "Model timeout in seconds" },
        repo_context: { type: "boolean", description: "Allow read-only repository tools (default true)" },
        no_secret_scan: { type: "boolean", description: "Disable secret scanning and redaction" },
      },
    },
  },
  {
    name: "test_fix",
    description:
      "Run the project's tests (or analyze captured test output) and explain the root cause with a minimal fix. Returns JSON.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        command: { type: "string", description: "Test command; auto-detected when omitted" },
        log: { type: "string", description: "Captured test output text; skips running tests" },
        exit_code: { type: "integer", minimum: 0, maximum: 255, description: "Exit code for log input (default 1)" },
        force: { type: "boolean", description: "Analyze even when tests pass" },
        no_diff: { type: "boolean", description: "Do not attach a git diff" },
        diff: { type: "string", description: "Unified diff text" },
        staged: { type: "boolean" },
        base: { type: "string" },
        include_untracked: { type: "boolean" },
        ...RESULT_PROPERTIES,
        context: { type: "string" },
        fail_on: { type: "string", enum: ["none", "critical", "warning", "style"] },
        lang: { type: "string", enum: ["en", "ru"] },
        model: { type: "string" },
        timeout: { type: "integer", minimum: 1 },
        repo_context: { type: "boolean" },
        no_secret_scan: { type: "boolean" },
      },
    },
  },
  {
    name: "docgen",
    description:
      "Generate GoDoc/RustDoc/JSDoc/docstrings for files or globs. Returns proposed documentation as Markdown and JSON.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["files"],
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "Files, directories or globs, e.g. src/core/*.ts",
        },
        symbol: { type: "string", description: "Document only this symbol" },
        context: { type: "string" },
        fail_on: { type: "string", enum: ["none", "critical", "warning", "style"] },
        lang: { type: "string", enum: ["en", "ru"] },
        model: { type: "string" },
        timeout: { type: "integer", minimum: 1 },
        repo_context: { type: "boolean" },
        no_secret_scan: { type: "boolean" },
      },
    },
  },
  {
    name: "custom",
    description:
      "Ask oc-pilot a free-form code question with optional diff and context. Returns Markdown and JSON.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["instruction"],
      properties: {
        instruction: { type: "string", description: "What to analyze or propose" },
        diff: { type: "string", description: "Unified diff text" },
        git_diff: { type: "boolean", description: "Attach git diff HEAD" },
        staged: { type: "boolean" },
        base: { type: "string" },
        include_untracked: { type: "boolean" },
        context: { type: "string" },
        fail_on: { type: "string", enum: ["none", "critical", "warning", "style"] },
        lang: { type: "string", enum: ["en", "ru"] },
        model: { type: "string" },
        timeout: { type: "integer", minimum: 1 },
        repo_context: { type: "boolean" },
        no_secret_scan: { type: "boolean" },
      },
    },
  },
  {
    name: "fix",
    description:
      "Ask the model for a unified diff and validate it with git apply. With apply=true, applies the patch and runs tests, reverting on failure and retrying.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "Optional pathspecs" },
        ...RESULT_PROPERTIES,
        diff: { type: "string", description: "Unified diff text. Omit to use the project's git diff." },
        base: { type: "string" },
        staged: { type: "boolean" },
        unstaged: { type: "boolean" },
        include_untracked: { type: "boolean" },
        context: { type: "string" },
        command: { type: "string", description: "Test command; auto-detected when omitted" },
        apply: { type: "boolean", description: "Apply the patch and run tests (default false)" },
        no_tests: { type: "boolean", description: "Apply without running tests" },
        rounds: { type: "integer", minimum: 1, maximum: 5, description: "Fix attempts (default 2)" },
        lang: { type: "string", enum: ["en", "ru"] },
        model: { type: "string" },
        timeout: { type: "integer", minimum: 1 },
        repo_context: { type: "boolean" },
        no_secret_scan: { type: "boolean" },
      },
    },
  },
  {
    name: "scan",
    description:
      "Offline secret scan of a git diff (no model call). Returns findings with masked previews and exits nonzero when critical secrets are found.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        paths: { type: "array", items: { type: "string" } },
        ...RESULT_PROPERTIES,
        diff: { type: "string", description: "Unified diff text. Omit to use git diff." },
        base: { type: "string" },
        staged: { type: "boolean" },
        unstaged: { type: "boolean" },
        include_untracked: { type: "boolean" },
        strict: { type: "boolean", description: "Fail on any finding, including warnings" },
        all: { type: "boolean", description: "Scan the whole repository instead of a diff" },
      },
    },
  },
  {
    name: "commit",
    description:
      "Generate a Conventional Commits message from the staged diff, matching the repository's recent commit style. Set apply to create the commit.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        diff: { type: "string", description: "Unified diff text. Omit to use the staged changes." },
        base: { type: "string", description: "Describe base...HEAD instead of staged changes" },
        unstaged: { type: "boolean", description: "Describe unstaged changes instead of staged" },
        include_untracked: { type: "boolean" },
        context: { type: "string", description: "Extra context for the model" },
        allow_secrets: { type: "boolean", description: "Commit even when critical secrets are staged" },
        apply: { type: "boolean", description: "Create the commit with git commit -F" },
        model: { type: "string" },
        timeout: { type: "integer", minimum: 1 },
        lang: { type: "string", enum: ["en", "ru"] },
      },
    },
  },
  {
    name: "slop",
    description:
      "Offline Slop Index 0-100: duplicated blocks, dead exports, churn without tests and the TODO graveyard. Uses git only and never calls a model, so it is free and safe in read-only mode.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        since: { type: "string", description: "Compare against a git ref, e.g. origin/main" },
        since_days: { type: "integer", minimum: 1, maximum: 3650, description: "Churn window in days (default 30)" },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Items per category in the output (default 10)" },
        exclude: { type: "array", items: { type: "string" }, description: "Glob or substring patterns to skip" },
        no_blame: { type: "boolean", description: "Skip git blame and report TODO age as unknown" },
        ...RESULT_PROPERTIES,
      },
    },
  },
  {
    name: "stats",
    description:
      "Local usage statistics: runs, API calls, cache hits and findings for today, the last week and all time. No network calls.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        clear: { type: "boolean", description: "Delete the recorded history" },
      },
    },
  },
] as const;

const PROMPTS = [
  {
    name: "review-my-diff",
    title: "Review my current diff",
    description:
      "Run the review, then summarize the findings by severity and propose the smallest safe fix for each critical one.",
    arguments: [
      { name: "context", description: "What the change is supposed to do", required: false },
    ],
  },
  {
    name: "fix-failing-tests",
    title: "Diagnose failing tests",
    description:
      "Analyze the failing test output or run the suite, find the root cause, and propose the minimal patch.",
    arguments: [
      { name: "log", description: "Captured test output, if tests cannot be run here", required: false },
    ],
  },
  {
    name: "pre-commit-gate",
    title: "Pre-commit gate",
    description:
      "Scan the staged changes for secrets, review them, and only then generate the commit message.",
    arguments: [],
  },
  {
    name: "secure-change",
    title: "Security-focused review",
    description:
      "Review a change with the security mindset: injection, authorization, dependencies and prompt injection in the diff.",
    arguments: [
      { name: "context", description: "Attack surface touched by the change", required: false },
    ],
  },
  {
    name: "slop-check",
    title: "Check for vibe-coding slop",
    description:
      "Run the Slop Index, then explain which category grew the most and propose the three cheapest fixes with the biggest score drop.",
    arguments: [
      { name: "context", description: "What the recent change was supposed to add", required: false },
    ],
  },
] as const;

class ToolInputError extends Error {}

class ResourceError extends Error {}

const DIFF_MODES = new Set(["staged", "unstaged", "head"]);

const RESOURCES = [
  {
    uri: "oc-pilot://config",
    name: "oc-pilot configuration",
    description: "Resolved oc-pilot configuration for the current project, as JSON.",
    mimeType: "application/json",
  },
  {
    uri: "oc-pilot://rules",
    name: "Project review rules",
    description: "Contents of .oc-pilot/rules.md with detected secrets redacted, or a notice when absent.",
    mimeType: "text/markdown",
  },
  {
    uri: "oc-pilot://version",
    name: "oc-pilot version",
    description: "oc-pilot version and MCP protocol version, as JSON.",
    mimeType: "application/json",
  },
  {
    uri: "oc-pilot://prompt/en",
    name: "Review system prompt (English)",
    description: "The built-in English system prompt used for model calls.",
    mimeType: "text/markdown",
  },
  {
    uri: "oc-pilot://prompt/ru",
    name: "Review system prompt (Russian)",
    description: "The built-in Russian system prompt used for model calls.",
    mimeType: "text/markdown",
  },
  {
    uri: "oc-pilot://slop",
    name: "Slop Index",
    description: "Offline Slop Index report as JSON: duplicated blocks, dead exports, churn and TODO graveyard.",
    mimeType: "application/json",
  },
];

const RESOURCE_TEMPLATES = [
  {
    uriTemplate: "oc-pilot://diff/{mode}",
    name: "Current git diff",
    description: "The project's git diff by mode: staged, unstaged or head.",
    mimeType: "text/plain",
  },
  {
    uriTemplate: "oc-pilot://scan/{mode}",
    name: "Offline secret scan",
    description: "Secret scan findings (masked previews only) for the diff by mode: staged, unstaged or head.",
    mimeType: "application/json",
  },
  {
    uriTemplate: "oc-pilot://file/{+path}",
    name: "Project file with secrets redacted",
    description: "Read-only contents of a project file (max 2 MB, text only) with detected secrets redacted.",
    mimeType: "text/plain",
  },
];

class TempFiles {
  private directory: string | undefined;

  write(name: string, content: string): string {
    this.directory ??= mkdtempSync(join(tmpdir(), "oc-pilot-mcp-"));
    const path = join(this.directory, name);
    writeFileSync(path, content, "utf8");
    return path;
  }

  cleanup(): void {
    if (!this.directory) return;
    try {
      rmSync(this.directory, { recursive: true, force: true });
    } catch {
      // Best-effort temp cleanup.
    }
  }
}

function stringArg(input: JsonObject, name: string, required = false): string | undefined {
  const value = input[name];
  if (value === undefined) {
    if (required) throw new ToolInputError(`${name} is required`);
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolInputError(`${name} must be a non-empty string`);
  }
  return value;
}

function booleanArg(input: JsonObject, name: string): boolean | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new ToolInputError(`${name} must be a boolean`);
  return value;
}

function integerArg(input: JsonObject, name: string): number | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ToolInputError(`${name} must be a positive integer`);
  }
  return value;
}

function stringArrayArg(input: JsonObject, name: string, required = false): string[] {
  const value = input[name];
  if (value === undefined) {
    if (required) throw new ToolInputError(`${name} is required`);
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new ToolInputError(`${name} must be an array of non-empty strings`);
  }
  return value as string[];
}

function projectPaths(input: JsonObject, name: string): string[] {
  const paths = stringArrayArg(input, name);
  for (const value of paths) {
    if (isAbsolute(value) || /(^|[\\/])\.\.([\\/]|$)/.test(value)) {
      throw new ToolInputError(`${name} must use paths inside the project directory`);
    }
  }
  return paths;
}

function baseArg(input: JsonObject): string | undefined {
  const base = stringArg(input, "base");
  if (!base) return undefined;
  if (base.startsWith("-") || !/^[A-Za-z0-9._/@{}~^:-]+$/.test(base)) {
    throw new ToolInputError("base must be a git ref, not an option");
  }
  return base;
}

function contextArg(input: JsonObject): string | undefined {
  const context = stringArg(input, "context");
  if (context?.trimStart().startsWith("@")) {
    throw new ToolInputError("context must be literal text, not an @file reference");
  }
  return context;
}

function parseResourceUri(uri: string): { kind: string; rest: string } {
  if (!uri.startsWith("oc-pilot://")) {
    throw new ResourceError(`Unsupported resource URI: ${uri}`);
  }
  const tail = uri.slice("oc-pilot://".length);
  const slash = tail.indexOf("/");
  if (slash === -1) return { kind: tail, rest: "" };
  let rest: string;
  try {
    rest = decodeURIComponent(tail.slice(slash + 1));
  } catch {
    throw new ResourceError(`Malformed resource URI: ${uri}`);
  }
  return { kind: tail.slice(0, slash), rest };
}

function diffForMode(mode: string, cwd: string): string {
  const args =
    mode === "staged" ? ["diff", "--cached"] : mode === "head" ? ["diff", "HEAD"] : ["diff"];
  const result = runGit(args, cwd);
  if (result.status !== 0) {
    throw new ResourceError(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`.trim());
  }
  return result.stdout;
}

function readResourceText(uri: string, cwd: string): { mimeType: string; text: string } {
  const { kind, rest } = parseResourceUri(uri);

  if (kind === "config") {
    try {
      const loaded = loadConfig({ cwd });
      return {
        mimeType: "application/json",
        text: JSON.stringify({ config: loaded.config, path: loaded.path ?? null }, null, 2),
      };
    } catch (error) {
      throw new ResourceError(`config error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (kind === "rules") {
    const rules = loadRules(cwd);
    return {
      mimeType: "text/markdown",
      text: rules ? rules.text : "(no .oc-pilot/rules.md found)",
    };
  }

  if (kind === "version") {
    return {
      mimeType: "application/json",
      text: JSON.stringify({ version: VERSION, protocol: PROTOCOL_VERSION }, null, 2),
    };
  }

  if (kind === "prompt") {
    if (rest === "en") return { mimeType: "text/markdown", text: SYSTEM_PROMPT_EN };
    if (rest === "ru") return { mimeType: "text/markdown", text: SYSTEM_PROMPT_RU };
    throw new ResourceError("Unknown prompt language; use oc-pilot://prompt/en or oc-pilot://prompt/ru");
  }

  if (kind === "slop") {
    // The report is cheap and offline, but the module is sync-only here.
    const result = spawnSync(process.execPath, [CLI_PATH, "slop", "--json"], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    const text = (result.stdout ?? "").trim();
    if (!text.startsWith("{")) {
      throw new ResourceError(`slop failed: ${(result.stderr ?? "").trim() || `exit ${result.status}`}`);
    }
    return { mimeType: "application/json", text };
  }

  if (kind === "diff") {
    if (!DIFF_MODES.has(rest)) {
      throw new ResourceError("Unknown diff mode; use staged, unstaged or head");
    }
    const diff = diffForMode(rest, cwd);
    // The diff goes to a host model: redact detected secrets first.
    const scan = scanDiff(diff, { ignore: loadSecretIgnore(cwd) });
    return { mimeType: "text/plain", text: scan.redacted };
  }

  if (kind === "scan") {
    if (!DIFF_MODES.has(rest)) {
      throw new ResourceError("Unknown scan mode; use staged, unstaged or head");
    }
    const diff = diffForMode(rest, cwd);
    const scan = scanDiff(diff, { ignore: loadSecretIgnore(cwd) });
    return {
      mimeType: "application/json",
      text: JSON.stringify({ mode: rest, findings: scan.findings }, null, 2),
    };
  }

  if (kind === "file") {
    if (!rest) throw new ResourceError("Missing file path; use oc-pilot://file/<path>");
    if (isAbsolute(rest) || /(^|[\\/])\.\.([\\/]|$)/.test(rest)) {
      throw new ResourceError("file path must stay inside the project directory");
    }
    const path = resolve(cwd, rest);
    if (path !== cwd && !path.startsWith(cwd + sep)) {
      throw new ResourceError("file path must stay inside the project directory");
    }
    let content: string;
    try {
      const stats = statSync(path);
      if (!stats.isFile()) throw new ResourceError(`Not a file: ${rest}`);
      if (stats.size > 2 * 1024 * 1024) throw new ResourceError(`File too large (max 2 MB): ${rest}`);
      content = readFileSync(path, "utf8");
    } catch (error) {
      if (error instanceof ResourceError) throw error;
      throw new ResourceError(`Cannot read ${rest}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (content.includes("\0")) throw new ResourceError("Binary files are not supported");
    const scan = scanText(content, rest.replace(/\\/g, "/"), { ignore: loadSecretIgnore(cwd) });
    return { mimeType: "text/plain", text: scan.redacted };
  }

  throw new ResourceError(`Unknown resource: ${uri}`);
}

function commonArgs(input: JsonObject, options: { repoContext: boolean; secrets: boolean; failOn: boolean }): string[] {
  const args: string[] = [];
  const lang = stringArg(input, "lang");
  const model = stringArg(input, "model");
  const timeout = integerArg(input, "timeout");
  const noSecretScan = options.secrets ? booleanArg(input, "no_secret_scan") : undefined;
  const failOn = options.failOn ? stringArg(input, "fail_on") : undefined;
  const repoContext = options.repoContext ? booleanArg(input, "repo_context") : undefined;

  if (model) args.push("--model", model);
  if (lang) args.push("--lang", lang);
  if (timeout) args.push("--timeout", String(timeout));
  if (noSecretScan) args.push("--no-secret-scan");
  if (failOn) args.push("--fail-on", failOn);
  if (repoContext === false) args.push("--no-repo-context");
  return args;
}

function runCli(args: string[], cwd: string): Promise<CliResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      },
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
      if (stderr.length > 40_000) stderr = stderr.slice(-40_000);
    });
    child.on("error", (error) => {
      resolvePromise({ exitCode: 1, stdout, stderr: `${stderr}\n${error.message}`.trim() });
    });
    child.on("close", (code) => {
      resolvePromise({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function parseJsonObject(text: string): JsonObject | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as JsonObject;
  } catch {
    // The CLI sometimes writes a plain-text error; fall through.
  }
  return undefined;
}

function toToolResult(result: CliResult): ToolResult {
  const parsed = parseJsonObject(result.stdout);
  if (parsed) {
    const policyFailed = result.exitCode === 3;
    return {
      content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }],
      structuredContent: parsed,
      isError: result.exitCode >= 2 && !policyFailed,
      _meta: { exitCode: result.exitCode, policyFailed },
    };
  }

  const text = result.stdout.trim() || result.stderr.trim() || `oc-pilot exited with code ${result.exitCode}.`;
  return {
    content: [{ type: "text", text }],
    isError: result.exitCode !== 0,
    _meta: { exitCode: result.exitCode },
  };
}

async function callReview(input: JsonObject, cwd: string): Promise<ToolResult> {
  const temp = new TempFiles();
  try {
    const args = ["review", ...commonArgs(input, { repoContext: true, secrets: true, failOn: true }), "--json"];
    const diff = stringArg(input, "diff");
    const base = baseArg(input);
    const context = contextArg(input);
    if (diff) args.push("--diff", temp.write("changes.diff", diff));
    if (base) args.push("--base", base);
    if (booleanArg(input, "staged")) args.push("--staged");
    if (booleanArg(input, "unstaged")) args.push("--unstaged");
    if (booleanArg(input, "include_untracked")) args.push("--include-untracked");
    if (context) args.push("--context", context);
    args.push(...projectPaths(input, "paths"));
    return toToolResult(await runCli(args, cwd));
  } finally {
    temp.cleanup();
  }
}

async function callTestFix(input: JsonObject, cwd: string): Promise<ToolResult> {
  const temp = new TempFiles();
  try {
    const args = ["test-fix", ...commonArgs(input, { repoContext: true, secrets: true, failOn: true }), "--json"];
    const command = stringArg(input, "command");
    const log = stringArg(input, "log");
    const diff = stringArg(input, "diff");
    const base = baseArg(input);
    const context = contextArg(input);
    const exitCode = integerArg(input, "exit_code");

    if (command) args.push("--command", command);
    if (log) args.push("--log", temp.write("test-output.log", log));
    if (exitCode !== undefined) args.push("--exit-code", String(exitCode));
    if (booleanArg(input, "force")) args.push("--force");
    if (booleanArg(input, "no_diff")) args.push("--no-diff");
    if (diff) args.push("--diff", temp.write("changes.diff", diff));
    if (base) args.push("--base", base);
    if (booleanArg(input, "staged")) args.push("--staged");
    if (booleanArg(input, "include_untracked")) args.push("--include-untracked");
    if (context) args.push("--context", context);
    return toToolResult(await runCli(args, cwd));
  } finally {
    temp.cleanup();
  }
}

async function callDocgen(input: JsonObject, cwd: string): Promise<ToolResult> {
  const files = projectPaths(input, "files");
  if (files.length === 0) throw new ToolInputError("files is required");
  const args = ["docgen", ...files, ...commonArgs(input, { repoContext: true, secrets: true, failOn: true }), "--json"];
  const symbol = stringArg(input, "symbol");
  const context = contextArg(input);
  if (symbol) args.push("--symbol", symbol);
  if (context) args.push("--context", context);
  return toToolResult(await runCli(args, cwd));
}

async function callCustom(input: JsonObject, cwd: string): Promise<ToolResult> {
  const instruction = stringArg(input, "instruction", true)!;
  const temp = new TempFiles();
  try {
    const args = [
      "custom",
      instruction,
      ...commonArgs(input, { repoContext: true, secrets: true, failOn: true }),
      "--json",
    ];
    const diff = stringArg(input, "diff");
    const base = baseArg(input);
    const context = contextArg(input);
    if (diff) args.push("--diff", temp.write("changes.diff", diff));
    if (booleanArg(input, "git_diff")) args.push("--git-diff");
    if (base) args.push("--base", base);
    if (booleanArg(input, "staged")) args.push("--staged");
    if (booleanArg(input, "include_untracked")) args.push("--include-untracked");
    if (context) args.push("--context", context);
    return toToolResult(await runCli(args, cwd));
  } finally {
    temp.cleanup();
  }
}

async function callFix(input: JsonObject, cwd: string): Promise<ToolResult> {
  const temp = new TempFiles();
  try {
    const args = ["fix", ...commonArgs(input, { repoContext: true, secrets: true, failOn: false }), "--json"];
    const diff = stringArg(input, "diff");
    const base = baseArg(input);
    const context = contextArg(input);
    const command = stringArg(input, "command");
    const rounds = integerArg(input, "rounds");
    if (diff) args.push("--diff", temp.write("changes.diff", diff));
    if (base) args.push("--base", base);
    if (booleanArg(input, "staged")) args.push("--staged");
    if (booleanArg(input, "unstaged")) args.push("--unstaged");
    if (booleanArg(input, "include_untracked")) args.push("--include-untracked");
    if (context) args.push("--context", context);
    if (command) args.push("--command", command);
    if (booleanArg(input, "apply")) args.push("--apply");
    if (booleanArg(input, "no_tests")) args.push("--no-tests");
    if (rounds !== undefined) args.push("--rounds", String(rounds));
    args.push(...projectPaths(input, "paths"));
    return toToolResult(await runCli(args, cwd));
  } finally {
    temp.cleanup();
  }
}

async function callScan(input: JsonObject, cwd: string): Promise<ToolResult> {
  const temp = new TempFiles();
  try {
    const args = ["scan", "--json"];
    const diff = stringArg(input, "diff");
    const base = baseArg(input);
    if (diff) args.push("--diff", temp.write("changes.diff", diff));
    if (base) args.push("--base", base);
    if (booleanArg(input, "staged")) args.push("--staged");
    if (booleanArg(input, "unstaged")) args.push("--unstaged");
    if (booleanArg(input, "include_untracked")) args.push("--include-untracked");
    if (booleanArg(input, "strict")) args.push("--strict");
    if (booleanArg(input, "all")) args.push("--all");
    args.push(...projectPaths(input, "paths"));
    return toToolResult(await runCli(args, cwd));
  } finally {
    temp.cleanup();
  }
}

async function callCommit(input: JsonObject, cwd: string): Promise<ToolResult> {
  const temp = new TempFiles();
  try {
    const args = ["commit", "--json"];
    const diff = stringArg(input, "diff");
    const base = baseArg(input);
    if (diff) args.push("--diff", temp.write("changes.diff", diff));
    if (base) args.push("--base", base);
    if (booleanArg(input, "unstaged")) args.push("--unstaged");
    if (booleanArg(input, "include_untracked")) args.push("--include-untracked");
    if (booleanArg(input, "allow_secrets")) args.push("--allow-secrets");
    if (booleanArg(input, "apply")) args.push("--apply");
    const context = stringArg(input, "context");
    if (context) args.push("--context", context);
    const model = stringArg(input, "model");
    if (model) args.push("--model", model);
    const lang = stringArg(input, "lang");
    if (lang) args.push("--lang", lang);
    return toToolResult(await runCli(args, cwd));
  } finally {
    temp.cleanup();
  }
}

async function callStats(input: JsonObject, cwd: string): Promise<ToolResult> {
  const args = ["stats", "--json"];
  if (booleanArg(input, "clear")) args.push("--clear");
  return toToolResult(await runCli(args, cwd));
}

async function callSlop(input: JsonObject, cwd: string): Promise<ToolResult> {
  const args = ["slop", "--json"];
  const since = stringArg(input, "since");
  if (since) args.push("--since", since);
  const days = integerArg(input, "since_days");
  if (days !== undefined) args.push("--since-days", String(days));
  const limit = integerArg(input, "limit");
  if (limit !== undefined) args.push("--limit", String(limit));
  if (booleanArg(input, "no_blame")) args.push("--no-blame");
  for (const pattern of stringArrayArg(input, "exclude")) args.push("--exclude", pattern);
  return toToolResult(await runCli(args, cwd));
}

async function dispatchTool(name: string, input: JsonObject, cwd: string, readOnly: boolean): Promise<ToolResult> {
  if (readOnly) {
    if (name === "fix" && booleanArg(input, "apply")) {
      throw new ToolInputError("fix apply is disabled in read-only mode; start the MCP server with --allow-write");
    }
    if (name === "test_fix" && (stringArg(input, "command") || !stringArg(input, "log"))) {
      throw new ToolInputError("running tests is disabled in read-only mode; pass a captured log or start the server with --allow-write");
    }
    if (name === "commit" && booleanArg(input, "apply")) {
      throw new ToolInputError("commit apply is disabled in read-only mode; start the MCP server with --allow-write");
    }
    if (name === "stats" && booleanArg(input, "clear")) {
      throw new ToolInputError("stats clear is disabled in read-only mode; start the MCP server with --allow-write");
    }
  }
  switch (name) {
    case "review":
      return callReview(input, cwd);
    case "test_fix":
      return callTestFix(input, cwd);
    case "docgen":
      return callDocgen(input, cwd);
    case "custom":
      return callCustom(input, cwd);
    case "fix":
      return callFix(input, cwd);
    case "scan":
      return callScan(input, cwd);
    case "commit":
      return callCommit(input, cwd);
    case "stats":
      return callStats(input, cwd);
    case "slop":
      return callSlop(input, cwd);
    default:
      throw new ToolInputError(`Unknown tool: ${name}`);
  }
}

/** Patches larger than this are cut down before they reach an agent's context. */
const MAX_PATCH_CHARS = 200_000;

/** Metadata a host needs to render or apply a patch without parsing it again. */
export function patchSummary(patch: string): {
  files: string[];
  additions: number;
  deletions: number;
  hunks: number;
  bytes: number;
} {
  let files: string[] = [];
  try {
    files = patchTargets(patch);
  } catch {
    files = [];
  }

  let additions = 0;
  let deletions = 0;
  let hunks = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) hunks += 1;
    else if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }

  return { files, additions, deletions, hunks, bytes: patch.length };
}

/** Applies the cross-tool result options: finding caps and compact text. */
export function applyResultOptions(result: ToolResult, input: JsonObject): ToolResult {
  const structured = result.structuredContent;
  if (!structured) return result;

  let payload = structured;
  const cap = integerArg(input, "max_findings") ?? 50;
  const findings = structured.findings;
  if (Array.isArray(findings) && findings.length > cap) {
    payload = { ...structured, findings: findings.slice(0, cap), truncated: true, totalFindings: findings.length };
  }

  const patch = payload.patch;
  if (typeof patch === "string" && patch.trim()) {
    const meta = patchSummary(patch);
    payload = { ...payload, patchStats: meta, files: meta.files };
    if (patch.length > MAX_PATCH_CHARS) {
      payload = { ...payload, patch: patch.slice(0, MAX_PATCH_CHARS), patchTruncated: true, patchBytes: patch.length };
    }
  }

  const text = stringArg(input, "verbosity") === "compact" ? summarizeResult(payload) : JSON.stringify(payload, null, 2);
  return { ...result, structuredContent: payload, content: [{ type: "text", text }] };
}

/** One-line summary used by verbosity=compact. */
function summarizeResult(value: JsonObject): string {
  if (typeof value.index === "number") {
    return `oc-pilot: Slop Index ${value.index}/100 (${String(value.grade ?? "unknown")})`;
  }
  if (typeof value.patch === "string") {
    const stats = asObject(value.patchStats);
    const files = Array.isArray(value.files) ? value.files.length : 0;
    const additions = typeof stats?.additions === "number" ? stats.additions : 0;
    const deletions = typeof stats?.deletions === "number" ? stats.deletions : 0;
    const state = value.applied === true ? "applied" : "not applied";
    const truncated = value.patchTruncated === true ? ", patch truncated" : "";
    return `oc-pilot: fix ${files} file${files === 1 ? "" : "s"}, +${additions}/-${deletions} (${state})${truncated}`;
  }
  const findings = value.findings;
  if (Array.isArray(findings)) {
    const counts = new Map<string, number>();
    for (const item of findings) {
      const severity = asObject(item)?.severity;
      if (typeof severity === "string") counts.set(severity, (counts.get(severity) ?? 0) + 1);
    }
    const total = typeof value.totalFindings === "number" ? value.totalFindings : findings.length;
    const breakdown = [...counts].map(([severity, count]) => `${count} ${severity}`).join(", ");
    const shown = value.truncated === true ? `, showing ${findings.length}` : "";
    return `oc-pilot: ${total} finding${total === 1 ? "" : "s"}${breakdown ? ` (${breakdown})` : ""}${shown}`;
  }
  const message = value.summary ?? value.message;
  if (typeof message === "string") return message;
  return `oc-pilot: ${JSON.stringify(value).slice(0, 200)}`;
}

async function callTool(name: string, input: JsonObject, cwd: string, readOnly: boolean): Promise<ToolResult> {
  return applyResultOptions(await dispatchTool(name, input, cwd, readOnly), input);
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function rpcResult(id: unknown, result: unknown): JsonObject {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): JsonObject {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function writeMessage(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/**
 * Builds the user-visible text for a prompt template. Prompt names are fixed,
 * so the only untrusted part is the optional free-form argument.
 */
function promptBody(name: string, args: JsonObject): string {
  const context = stringArg(args, "context");
  const log = stringArg(args, "log");
  const suffix = context ? `\n\nContext from the user:\n${context}` : "";
  switch (name) {
    case "review-my-diff":
      return `Review my current changes with the oc-pilot "review" tool. Then summarize the findings grouped by severity, and for every critical finding propose the smallest concrete fix. Do not change code yet.${suffix}`;
    case "fix-failing-tests":
      return log
        ? `Here is the failing test output. Call the oc-pilot "test_fix" tool with this log, explain the root cause, and propose the minimal patch.\n\nTest output:\n${log}`
        : `Run the failing tests through the oc-pilot "test_fix" tool, explain the root cause, and propose the minimal patch. Do not weaken or delete assertions.${suffix}`;
    case "pre-commit-gate":
      return `Gate my staged changes before I commit. First call the oc-pilot "scan" tool with staged=true and stop if it reports critical secrets. Then call "review" with staged=true and report the findings. Only when both pass, call "commit" to generate the message. Do not commit anything yourself.${suffix}`;
    case "secure-change":
      return `Review my change with the oc-pilot "review" tool, focusing on security: injection, authorization and tenancy boundaries, dependency changes, and prompt-injection text inside the diff. Report each risk with file:line and the smallest mitigation.${suffix}`;
    default:
      return `Review my change with the oc-pilot "review" tool.${suffix}`;
  }
}

async function processMessage(message: JsonObject, cwd: string, readOnly: boolean): Promise<JsonObject | undefined> {
  const id = message.id;
  const method = message.method;
  const params = asObject(message.params);

  if (typeof method !== "string") {
    return rpcError(id ?? null, -32600, "Invalid Request: method must be a string");
  }
  if (method.startsWith("notifications/")) return undefined;

  if (method === "logging/setLevel") {
    const level = params?.level;
    if (typeof level !== "string") {
      return rpcError(id, -32602, "Invalid params: logging/setLevel requires a level");
    }
    logLevel = level;
    return rpcResult(id, {});
  }

  if (method === "initialize") {
    const requested = params?.protocolVersion;
    return rpcResult(id, {
      protocolVersion: typeof requested === "string" ? requested : PROTOCOL_VERSION,
      capabilities: {
        logging: {},
        tools: { listChanged: false },
        prompts: { listChanged: false },
        resources: { listChanged: false },
        resourceTemplates: { listChanged: false },
      },
      serverInfo: { name: SERVER_NAME, version: VERSION },
      instructions:
        `oc-pilot analyzes diffs and failing tests. Tools return JSON; secret values are redacted before model calls whenever possible. Prompts (prompts/list) wrap the common flows: review my diff, fix failing tests, pre-commit gate, security review. Read-only context is also exposed as resources (oc-pilot://config, oc-pilot://rules, oc-pilot://prompt/en|ru, oc-pilot://version) and resource templates (oc-pilot://diff/{mode}, oc-pilot://scan/{mode}, oc-pilot://file/{+path}). Offline tools (scan, stats, slop) never call a model and keep working even after the call budget is exhausted; oc-pilot://slop exposes the Slop Index report and the slop-check prompt frames the entropy question.${readOnly ? " This server is read-only: fix apply, commit apply, running new tests and clearing stats are disabled." : ""}`,
    });
  }

  if (method === "ping") return rpcResult(id, {});

  if (method === "tools/list") return rpcResult(id, { tools: TOOLS });

  if (method === "prompts/list") {
    return rpcResult(id, {
      prompts: PROMPTS.map((prompt) => ({
        name: prompt.name,
        title: prompt.title,
        description: prompt.description,
        arguments: prompt.arguments,
      })),
    });
  }

  if (method === "prompts/get") {
    const name = params?.name;
    if (typeof name !== "string" || name.trim() === "") {
      return rpcError(id, -32602, "Invalid params: prompts/get requires a prompt name");
    }
    const prompt = PROMPTS.find((candidate) => candidate.name === name);
    if (!prompt) return rpcError(id, -32602, `Unknown prompt: ${name}`);
    const args = asObject(params?.arguments) ?? {};
    return rpcResult(id, {
      description: prompt.description,
      messages: [{ role: "user", content: { type: "text", text: promptBody(prompt.name, args) } }],
    });
  }

  if (method === "resources/list") return rpcResult(id, { resources: RESOURCES });

  if (method === "resources/templates/list") {
    return rpcResult(id, { resourceTemplates: RESOURCE_TEMPLATES });
  }

  if (method === "resources/read") {
    const uri = params?.uri;
    if (typeof uri !== "string" || uri.trim() === "") {
      return rpcError(id, -32602, "Invalid params: resources/read requires a uri");
    }
    try {
      const resource = readResourceText(uri, cwd);
      return rpcResult(id, {
        contents: [{ uri, mimeType: resource.mimeType, text: resource.text }],
      });
    } catch (error) {
      return rpcError(id, -32002, error instanceof Error ? error.message : String(error));
    }
  }

  if (method === "tools/call") {
    const name = params?.name;
    if (typeof name !== "string") {
      return rpcError(id, -32602, "Invalid params: tools/call requires a tool name");
    }
    if (!OFFLINE_TOOLS.has(name) && maxToolCalls > 0 && toolCallsUsed >= maxToolCalls) {
      return rpcResult(id, {
        content: [
          {
            type: "text",
            text: `Tool budget exhausted (${maxToolCalls} model-backed calls per session). Restart the server to reset, raise --max-calls, or use the offline tools: scan, stats, slop.`,
          },
        ],
        isError: true,
      });
    }
    const input = asObject(params?.arguments) ?? {};
    const token = asObject(params?._meta)?.progressToken;
    const notify = typeof token === "number" || typeof token === "string";
    const startedAt = Date.now();
    if (emitNotification && notify) {
      emitNotification({
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken: token, progress: 0, total: 1, message: `Running ${name}` },
      });
    }
    if (!OFFLINE_TOOLS.has(name)) toolCallsUsed += 1;
    try {
      const result = await callTool(name, input, cwd, readOnly);
      if (emitNotification && notify) {
        emitNotification({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progressToken: token, progress: 1, total: 1, message: `${name} finished` },
        });
      }
      if (emitNotification && logLevel) {
        emitNotification({
          jsonrpc: "2.0",
          method: "notifications/message",
          params: {
            level: "info",
            logger: "oc-pilot",
            data: { tool: name, exitCode: result._meta?.exitCode ?? 0, durationMs: Date.now() - startedAt },
          },
        });
      }
      return rpcResult(id, result);
    } catch (error) {
      if (error instanceof ToolInputError) {
        return rpcResult(id, { content: [{ type: "text", text: error.message }], isError: true });
      }
      return rpcResult(id, {
        content: [{ type: "text", text: `oc-pilot failed: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      });
    }
  }

  return rpcError(id ?? null, -32601, `Method not found: ${method}`);
}

async function processPayload(message: unknown, cwd: string, readOnly: boolean): Promise<JsonObject | JsonObject[] | undefined> {
  if (Array.isArray(message)) {
    if (message.length === 0) return rpcError(null, -32600, "Invalid Request: empty batch");
    const responses: JsonObject[] = [];
    for (const item of message) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        responses.push(rpcError(null, -32600, "Invalid Request"));
        continue;
      }
      const response = await processMessage(item as JsonObject, cwd, readOnly);
      if (response) responses.push(response);
    }
    return responses.length > 0 ? responses : undefined;
  }
  if (!message || typeof message !== "object") {
    return rpcError(null, -32600, "Invalid Request");
  }
  return processMessage(message as JsonObject, cwd, readOnly);
}

async function serveStdio(cwd: string, readOnly: boolean): Promise<void> {
  emitNotification = (message) => writeMessage(message);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      writeMessage(rpcError(null, -32700, "Parse error"));
      continue;
    }

    const response = await processPayload(message, cwd, readOnly);
    if (response) writeMessage(response);
  }
  emitNotification = undefined;
}

interface HttpConfig {
  host: string;
  port: number;
  path: string;
  token?: string;
  cors?: string;
  readOnly: boolean;
}

function corsHeaders(config: HttpConfig): Record<string, string> {
  if (!config.cors) return {};
  return {
    "Access-Control-Allow-Origin": config.cors,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
    "Access-Control-Max-Age": "86400",
  };
}

function authorized(req: IncomingMessage, config: HttpConfig): boolean {
  if (!config.token) return true;
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(config.token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function sendJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...headers,
  });
  response.end(body);
}

async function readBody(request: IncomingMessage, limit = 16 * 1024 * 1024): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

async function startHttp(cwd: string, config: HttpConfig): Promise<Server> {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const cors = corsHeaders(config);

    if (request.method === "OPTIONS") {
      response.writeHead(204, cors);
      response.end();
      return;
    }

    if (url.pathname === "/health" || (url.pathname === "/" && request.method === "GET")) {
      const body = JSON.stringify({ status: "ok", name: SERVER_NAME, version: VERSION });
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        ...cors,
      });
      response.end(body);
      return;
    }

    if (url.pathname !== config.path) {
      sendJson(response, 404, { error: "not_found" }, cors);
      return;
    }

    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST, OPTIONS", ...cors });
      response.end();
      return;
    }

    if (!authorized(request, config)) {
      response.writeHead(401, {
        "WWW-Authenticate": 'Bearer realm="oc-pilot"',
        "Content-Type": "application/json; charset=utf-8",
        ...cors,
      });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    let message: unknown;
    try {
      const body = await readBody(request);
      message = JSON.parse(body);
    } catch (error) {
      sendJson(
        response,
        400,
        rpcError(null, -32700, error instanceof Error && error.message === "Request body too large" ? "Request body too large" : "Parse error"),
        cors,
      );
      return;
    }

    let result: JsonObject | JsonObject[] | undefined;
    try {
      result = await processPayload(message, cwd, config.readOnly);
    } catch (error) {
      sendJson(
        response,
        500,
        rpcError(null, -32603, `Internal error: ${error instanceof Error ? error.message : String(error)}`),
        cors,
      );
      return;
    }

    if (!result) {
      response.writeHead(202, cors);
      response.end();
      return;
    }

    const isInitialize =
      !Array.isArray(result) &&
      result.result !== undefined &&
      typeof result.result === "object" &&
      result.result !== null &&
      "serverInfo" in result.result;

    sendJson(response, 200, result, {
      ...cors,
      ...(isInitialize ? { "Mcp-Session-Id": randomUUID() } : {}),
    });
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => resolvePromise());
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  process.stderr.write(
    `oc-pilot-mcp listening on http://${config.host}:${port}${config.path}${config.readOnly ? " (read-only)" : ""}\n`,
  );
  return server;
}

function usage(): string {
  return `oc-pilot-mcp ${VERSION} — MCP server for oc-pilot

Usage:
  oc-pilot-mcp [--cwd <project>] [--help] [--version]
  oc-pilot-mcp --http [--host <host>] [--port <port>] [--path <path>] [--token <token>]

Options:
  -C, --cwd <dir>     Project directory the tools operate on (default: current)
      --http          Serve Streamable HTTP instead of stdio
      --host <host>   HTTP bind address (default: 127.0.0.1)
      --port <port>   HTTP port, 0 picks a free port (default: 8787)
      --path <path>   HTTP endpoint path (default: /mcp)
      --token <token> Require Authorization: Bearer <token>
      --cors <origin> Add CORS headers for an origin, or *
      --max-calls <n> Model-backed tool calls per session, 0 disables the limit (default: 50)
      --read-only     Disable fix --apply and running new tests (default)
      --allow-write   Enable fix --apply and running new tests
  -h, --help          Show this help
      --version       Show version

Environment:
  OC_PILOT_MCP_HOST, OC_PILOT_MCP_PORT, OC_PILOT_MCP_PATH,
  OC_PILOT_MCP_TOKEN, OC_PILOT_MCP_CORS, OC_PILOT_MCP_READ_ONLY,
  OC_PILOT_MCP_MAX_CALLS

The offline tools (scan, stats, slop) never call a model and keep working
after the call budget is exhausted. oc-pilot://slop exposes the Slop Index.

Examples:
  oc-pilot-mcp --cwd /path/to/project
  oc-pilot-mcp --http --host 0.0.0.0 --port 8787 --token "$OC_PILOT_MCP_TOKEN"
  oc-pilot-mcp --http --host 127.0.0.1 --port 8787 --allow-write
  curl http://127.0.0.1:8787/health
`;
}

function parseServerArgs(argv: string[]): {
  cwd: string;
  action?: "help" | "version";
  readOnly: boolean;
  maxCalls: number;
  http?: HttpConfig;
} {
  let cwd = process.cwd();
  let http = false;
  let host = process.env.OC_PILOT_MCP_HOST ?? "127.0.0.1";
  let port = Number(process.env.OC_PILOT_MCP_PORT ?? "8787");
  let path = process.env.OC_PILOT_MCP_PATH ?? "/mcp";
  let token = process.env.OC_PILOT_MCP_TOKEN;
  let cors = process.env.OC_PILOT_MCP_CORS;
  const envReadOnly = process.env.OC_PILOT_MCP_READ_ONLY;
  let readOnly: boolean | undefined =
    envReadOnly === "1" || envReadOnly === "true" ? true : envReadOnly === "0" || envReadOnly === "false" ? false : undefined;
  let allowWrite = false;
  let maxCalls = Number(process.env.OC_PILOT_MCP_MAX_CALLS ?? "50");

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { cwd, action: "help", readOnly: false, maxCalls };
    if (arg === "--version" || arg === "-V") return { cwd, action: "version", readOnly: false, maxCalls };
    if (arg === "--http") {
      http = true;
      continue;
    }
    if (arg === "--read-only") {
      readOnly = true;
      continue;
    }
    if (arg === "--allow-write") {
      allowWrite = true;
      continue;
    }
    const next = (): string => {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === "--cwd" || arg === "-C") {
      cwd = resolve(process.cwd(), next());
      continue;
    }
    if (arg === "--host") {
      host = next();
      continue;
    }
    if (arg === "--port") {
      port = Number(next());
      continue;
    }
    if (arg === "--path") {
      path = next();
      continue;
    }
    if (arg === "--token") {
      token = next();
      continue;
    }
    if (arg === "--cors") {
      cors = next();
      continue;
    }
    if (arg === "--max-calls") {
      maxCalls = Number(next());
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new Error(`Directory not found: ${cwd}`);
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${port}`);
  }
  if (!path.startsWith("/")) {
    throw new Error(`HTTP path must start with /: ${path}`);
  }
  if (readOnly === true && allowWrite) {
    throw new Error("--read-only and --allow-write are mutually exclusive");
  }
  if (!Number.isInteger(maxCalls) || maxCalls < 0) {
    throw new Error(`Invalid max calls: ${process.env.OC_PILOT_MCP_MAX_CALLS ?? "not a number"}`);
  }
  const effectiveReadOnly = readOnly ?? !allowWrite;

  return {
    cwd,
    readOnly: effectiveReadOnly,
    maxCalls,
    ...(http ? { http: { host, port, path, token, cors, readOnly: effectiveReadOnly } } : {}),
  };
}

export async function runMcp(argv: string[] = process.argv.slice(2)): Promise<number> {
  let parsed: ReturnType<typeof parseServerArgs>;
  try {
    parsed = parseServerArgs(argv);
    maxToolCalls = parsed.maxCalls;
  } catch (error) {
    process.stderr.write(`oc-pilot-mcp: ${error instanceof Error ? error.message : String(error)}\n\n${usage()}`);
    return 2;
  }

  if (parsed.action === "help") {
    process.stdout.write(usage());
    return 0;
  }
  if (parsed.action === "version") {
    process.stdout.write(`oc-pilot-mcp ${VERSION}\n`);
    return 0;
  }

  if (parsed.http) {
    const loopback = parsed.http.host === "127.0.0.1" || parsed.http.host === "localhost" || parsed.http.host === "::1";
    if (!loopback && !parsed.http.token) {
      process.stderr.write(
        "oc-pilot-mcp: refusing to expose HTTP without a token; set --token or OC_PILOT_MCP_TOKEN.\n",
      );
      return 2;
    }
    if (!loopback && parsed.http.token && parsed.http.token.length < 16) {
      process.stderr.write("oc-pilot-mcp: token must be at least 16 characters for a non-loopback bind.\n");
      return 2;
    }
    const server = await startHttp(parsed.cwd, parsed.http);
    const shutdown = (): void => {
      server.close(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return 0;
  }

  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
  });

  await serveStdio(parsed.cwd, parsed.readOnly);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMcp()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`oc-pilot-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
