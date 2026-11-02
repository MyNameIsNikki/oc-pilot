#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { VERSION } from "./version.js";

const SERVER_NAME = "oc-pilot";
const PROTOCOL_VERSION = "2025-06-18";
const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), "cli.js");

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
        diff: { type: "string", description: "Unified diff text. Omit to use git diff." },
        base: { type: "string" },
        staged: { type: "boolean" },
        unstaged: { type: "boolean" },
        include_untracked: { type: "boolean" },
        strict: { type: "boolean", description: "Fail on any finding, including warnings" },
      },
    },
  },
] as const;

class ToolInputError extends Error {}

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
    args.push(...projectPaths(input, "paths"));
    return toToolResult(await runCli(args, cwd));
  } finally {
    temp.cleanup();
  }
}

async function callTool(name: string, input: JsonObject, cwd: string, readOnly: boolean): Promise<ToolResult> {
  if (readOnly) {
    if (name === "fix" && booleanArg(input, "apply")) {
      throw new ToolInputError("fix apply is disabled in read-only mode; start the MCP server with --allow-write");
    }
    if (name === "test_fix" && (stringArg(input, "command") || !stringArg(input, "log"))) {
      throw new ToolInputError("running tests is disabled in read-only mode; pass a captured log or start the server with --allow-write");
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
    default:
      throw new ToolInputError(`Unknown tool: ${name}`);
  }
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

async function processMessage(message: JsonObject, cwd: string, readOnly: boolean): Promise<JsonObject | undefined> {
  const id = message.id;
  const method = message.method;
  const params = asObject(message.params);

  if (typeof method !== "string") {
    return rpcError(id ?? null, -32600, "Invalid Request: method must be a string");
  }
  if (method.startsWith("notifications/")) return undefined;

  if (method === "initialize") {
    const requested = params?.protocolVersion;
    return rpcResult(id, {
      protocolVersion: typeof requested === "string" ? requested : PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: VERSION },
      instructions:
        `oc-pilot analyzes diffs and failing tests. Tools return JSON; secret values are redacted before model calls whenever possible.${readOnly ? " This server is read-only: fix apply and running new tests are disabled." : ""}`,
    });
  }

  if (method === "ping") return rpcResult(id, {});

  if (method === "tools/list") return rpcResult(id, { tools: TOOLS });

  if (method === "tools/call") {
    const name = params?.name;
    if (typeof name !== "string") {
      return rpcError(id, -32602, "Invalid params: tools/call requires a tool name");
    }
    const input = asObject(params?.arguments) ?? {};
    try {
      return rpcResult(id, await callTool(name, input, cwd, readOnly));
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
      --read-only     Disable fix --apply and running new tests
      --allow-write   Allow writes over HTTP (HTTP is read-only by default)
  -h, --help          Show this help
      --version       Show version

Environment:
  OC_PILOT_MCP_HOST, OC_PILOT_MCP_PORT, OC_PILOT_MCP_PATH,
  OC_PILOT_MCP_TOKEN, OC_PILOT_MCP_CORS, OC_PILOT_MCP_READ_ONLY

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

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { cwd, action: "help", readOnly: false };
    if (arg === "--version" || arg === "-V") return { cwd, action: "version", readOnly: false };
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
  const effectiveReadOnly = readOnly ?? (http ? !allowWrite : false);

  return {
    cwd,
    readOnly: effectiveReadOnly,
    ...(http ? { http: { host, port, path, token, cors, readOnly: effectiveReadOnly } } : {}),
  };
}

export async function runMcp(argv: string[] = process.argv.slice(2)): Promise<number> {
  let parsed: ReturnType<typeof parseServerArgs>;
  try {
    parsed = parseServerArgs(argv);
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
