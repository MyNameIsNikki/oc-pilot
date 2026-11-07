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
const OFFLINE_TOOLS = new Set(["scan", "stats", "slop", "flaky", "impact", "deps", "coverage", "reviewers", "test_guard", "env_sync", "mock_leak", "ecosystem_verify", "pack", "contract_drift", "anti_regression", "boundaries", "test_plan", "compliance_verify", "brag", "arch_diff", "cinema", "bounty", "autopsy", "echo", "sast", "authz", "preflight", "ready", "receipt_verify"]);
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
    name: "test_gen",
    description:
      "Generate tests for the changed code, or only for uncovered changed lines when coverage is requested. Without apply it returns a patch and writes nothing; with apply it writes the test files, runs the suite and reverts failing tests unless keep_failing is set. Model-backed.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        apply: { type: "boolean", description: "Write the generated tests; needs --allow-write (default false)" },
        no_run: { type: "boolean", description: "With apply, write tests without running them" },
        keep_failing: { type: "boolean", description: "Keep generated tests even when the suite fails" },
        force: { type: "boolean", description: "Allow editing existing test files" },
        rounds: { type: "integer", minimum: 1, maximum: 5, description: "Generation attempts (default 2)" },
        coverage: { type: "boolean", description: "Target only uncovered changed lines" },
        coverage_file: { type: "string", description: "Coverage report path (lcov, Istanbul, Cobertura or Go)" },
        from_slop: { type: "boolean", description: "Select untested files with the Slop Index instead of the diff" },
        slop_files: { type: "integer", minimum: 1, maximum: 50, description: "How many untested files to target (default 3)" },
        command: { type: "string", description: "Test command; auto-detected when omitted" },
        diff: { type: "string", description: "Unified diff text. Omit to use the project's git diff." },
        base: { type: "string" },
        staged: { type: "boolean" },
        unstaged: { type: "boolean" },
        include_untracked: { type: "boolean" },
        paths: { type: "array", items: { type: "string" } },
        context: { type: "string" },
        ...RESULT_PROPERTIES,
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
      "Ask the model for a unified diff and validate it with git apply. With from_sast or from_authz it targets security findings and rescans after the patch. With apply=true, applies the patch and runs tests, reverting on failure and retrying.",
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
        from_sast: {
          type: "boolean",
          description: "Fix high-severity SAST findings in the changed files and rescan",
        },
        from_authz: {
          type: "boolean",
          description: "Fix high-severity route authorization findings and rescan",
        },
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
    name: "fuzz",
    description:
      "Safely fuzz exported functions added by the diff with null, -1, empty values, a 10MB string and __proto__ objects. Each function runs in a separate Node process with a hard timeout, a heap cap and mocked fs/net/http/child_process; files that import side-effect modules are blocked instead of executed. No model call.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        diff: { type: "string", description: "Unified diff text. Omit to use the project's git diff." },
        base: { type: "string" },
        staged: { type: "boolean" },
        unstaged: { type: "boolean" },
        include_untracked: { type: "boolean" },
        duration_ms: { type: "integer", minimum: 100, maximum: 60000, description: "Total fuzz budget (default 2000)" },
        memory_mb: { type: "integer", minimum: 16, maximum: 4096, description: "Heap cap per worker (default 128)" },
        max_targets: { type: "integer", minimum: 1, maximum: 50, description: "Maximum functions to fuzz (default 10)" },
        fail_on_crash: { type: "boolean", description: "Return exit code 1 when a crash is found" },
        ...RESULT_PROPERTIES,
      },
    },
  },
  {
    name: "mutate",
    description:
      "Offline mutation testing for changed code: flips comparison and boolean operators, runs the test command after each mutation, restores the file and reports survivors. Mutants are capped by max_mutants; a score below min_score returns exit code 1. Temporarily rewrites source files, so it is disabled in read-only mode.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "Optional pathspecs; defaults to all changed code files" },
        diff: { type: "string", description: "Unified diff text. Omit to use the project's git diff." },
        base: { type: "string", description: "Mutate git diff <base>...HEAD, e.g. origin/main" },
        staged: { type: "boolean", description: "Mutate staged changes" },
        unstaged: { type: "boolean", description: "Mutate unstaged changes" },
        include_untracked: { type: "boolean", description: "Include untracked files when diffing" },
        command: { type: "string", description: "Test command; auto-detected when omitted" },
        max_mutants: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "How many mutations to try (default 20)",
        },
        min_score: {
          type: "integer",
          minimum: 0,
          maximum: 100,
          description: "Return exit code 1 when the mutation score is below this value",
        },
        ...RESULT_PROPERTIES,
      },
    },
  },
  {
    name: "flaky",
    description:
      "Run the test command several times and compare per-test results, flagging tests that pass in some runs and fail in others. With shuffle=true it reorders test files using a reproducible seed. It never edits source files itself, but the test command may write build artifacts. Offline and free of model calls; fail_on_flaky returns exit code 1 when a flaky test is found.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        runs: { type: "integer", minimum: 1, maximum: 10, description: "How many times to run the tests (default 3)" },
        command: { type: "string", description: "Test command; auto-detected when omitted" },
        fail_on_flaky: { type: "boolean", description: "Return exit code 1 when any test is flaky" },
        shuffle: { type: "boolean", description: "Shuffle test files between runs; the command must contain {files}" },
        seed: { type: "string", description: "Shuffle seed; random when omitted" },
        ...RESULT_PROPERTIES,
      },
    },
  },
  {
    name: "impact",
    description:
      "Show which declarations the diff changed or removed and where else those names are used. References in untouched files are the call sites most likely to break; the search is textual, so comments and strings can match. Offline and free of model calls.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        diff: { type: "string", description: "Unified diff text. Omit to use the project's git diff." },
        base: { type: "string", description: "Analyze git diff <base>...HEAD, e.g. origin/main" },
        staged: { type: "boolean", description: "Analyze staged changes" },
        unstaged: { type: "boolean", description: "Analyze unstaged changes" },
        include_untracked: { type: "boolean", description: "Include untracked files when diffing" },
        paths: { type: "array", items: { type: "string" }, description: "Optional pathspecs" },
        ...RESULT_PROPERTIES,
      },
    },
  },
  {
    name: "deps",
    description:
      "Audit declared and imported dependencies: phantom imports, unused or missing packages, floating versions and lockfile health. With audit=true it also queries OSV for vulnerabilities and checks licenses; offline=true keeps the audit to the local advisory cache. fix=true rewrites package.json and sbom writes a file, so both need --allow-write. No model call.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        why: { type: "string", description: "Explain where this package comes from instead of auditing" },
        audit: { type: "boolean", description: "Query OSV for vulnerabilities and audit licenses" },
        offline: { type: "boolean", description: "Keep the audit offline; requires audit" },
        osv_url: { type: "string", description: "Override the OSV API base URL; requires audit" },
        fail_on_issue: {
          type: "string",
          enum: ["high", "medium", "low"],
          description: "Lowest dependency issue severity that fails the run",
        },
        fail_on_vuln: {
          type: "string",
          enum: ["critical", "high", "medium", "low"],
          description: "Lowest vulnerability severity that fails the run; requires audit",
        },
        ignore: { type: "array", items: { type: "string" }, description: "Package names to ignore" },
        fix: { type: "boolean", description: "Apply safe package.json fixes; needs --allow-write" },
        sbom: { type: "string", description: "Write a CycloneDX SBOM to this path; needs --allow-write" },
        ...RESULT_PROPERTIES,
      },
    },
  },
  {
    name: "coverage",
    description:
      "Changed-line coverage from a local lcov, Istanbul, Cobertura or Go report: reports uncovered changed lines and files with no coverage data. Gate on the covered percentage or the number of uncovered lines. Offline and free of model calls.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        coverage_file: {
          type: "string",
          description: "Coverage report path; auto-detected from coverage/lcov.info and other common paths",
        },
        fail_under: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Return exit code 1 when less than this percentage of changed executable lines is covered",
        },
        max_uncovered: {
          type: "integer",
          minimum: 0,
          description: "Return exit code 1 when more changed lines are uncovered",
        },
        diff: { type: "string", description: "Unified diff text. Omit to use the project's git diff." },
        base: { type: "string", description: "Check git diff <base>...HEAD, e.g. origin/main" },
        staged: { type: "boolean", description: "Check staged changes" },
        unstaged: { type: "boolean", description: "Check unstaged changes" },
        include_untracked: { type: "boolean", description: "Include untracked files when diffing" },
        paths: { type: "array", items: { type: "string" }, description: "Optional pathspecs" },
        ...RESULT_PROPERTIES,
      },
    },
  },
  {
    name: "reviewers",
    description:
      "Suggest reviewers for the changed files from git history and CODEOWNERS. Ranks authors by commits touching those files, filters bots and excluded logins, and lists CODEOWNERS owners. Offline, read-only and free of model calls.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        diff: { type: "string", description: "Unified diff text. Omit to use the project's git diff." },
        base: { type: "string", description: "Review git diff <base>...HEAD, e.g. origin/main" },
        staged: { type: "boolean", description: "Only staged changes" },
        unstaged: { type: "boolean", description: "Only unstaged changes" },
        include_untracked: { type: "boolean", description: "Include untracked files" },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "How many reviewers to return (default 3)" },
        depth: { type: "integer", minimum: 1, maximum: 5000, description: "How many commits to scan (default 50)" },
        exclude: { type: "array", items: { type: "string" }, description: "Logins, names or emails to skip" },
        paths: { type: "array", items: { type: "string" }, description: "Optional pathspecs" },
        ...RESULT_PROPERTIES,
      },
    },
  },
  {
    name: "test_guard",
    description:
      "Offline guard against weakened tests in a diff: skipped or focused tests, removed assertions, commented checks, raised timeouts, strict matchers replaced by existence checks, @ts-ignore, empty catch blocks and deleted tests. Read-only and free of model calls; findings do not fail unless fail_on_weakening is set.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        diff: { type: "string", description: "Unified diff text. Omit to use the project's git diff." },
        base: { type: "string", description: "Check git diff <base>...HEAD, e.g. origin/main" },
        staged: { type: "boolean", description: "Only staged changes" },
        unstaged: { type: "boolean", description: "Only unstaged changes" },
        include_untracked: { type: "boolean", description: "Include untracked files" },
        fail_on_weakening: { type: "boolean", description: "Return exit code 1 when any weakening is found" },
        paths: { type: "array", items: { type: "string" }, description: "Optional pathspecs" },
        ...RESULT_PROPERTIES,
      },
    },
  },
  {
    name: "env_sync",
    description:
      "Offline audit of environment variables added by the diff: every process.env, import.meta.env, Deno.env and Bun.env reference is checked against the local .env files and the .env.example/.sample/.template documentation. Reports variables that are referenced but not defined and ones defined but not documented. Read-only and free of model calls; missing variables return exit code 1 only when fail_on_missing is set.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        diff: { type: "string", description: "Unified diff text. Omit to use the project's git diff." },
        base: { type: "string", description: "Check git diff <base>...HEAD, e.g. origin/main" },
        staged: { type: "boolean", description: "Only staged changes" },
        unstaged: { type: "boolean", description: "Only unstaged changes" },
        include_untracked: { type: "boolean", description: "Include untracked files" },
        fail_on_missing: { type: "boolean", description: "Return exit code 1 when a referenced variable is not defined" },
        paths: { type: "array", items: { type: "string" }, description: "Optional pathspecs" },
        ...RESULT_PROPERTIES,
      },
    },
  },
  {
    name: "mock_leak",
    description:
      "Offline scan of added production code for forgotten stubs and hardcode: local paths such as C:/Users or /home, test tokens, always-true and always-false conditions, mock/fake/stub identifiers, mock comments and localhost URLs. Test, generated and documentation files are skipped. Read-only and free of model calls; findings at or above fail_on return exit code 1.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        diff: { type: "string", description: "Unified diff text. Omit to use the project's git diff." },
        base: { type: "string", description: "Check git diff <base>...HEAD, e.g. origin/main" },
        staged: { type: "boolean", description: "Only staged changes" },
        unstaged: { type: "boolean", description: "Only unstaged changes" },
        include_untracked: { type: "boolean", description: "Include untracked files" },
        fail_on_leak: {
          type: "string",
          enum: ["high", "medium", "low"],
          description: "Lowest severity that returns exit code 1",
        },
        paths: { type: "array", items: { type: "string" }, description: "Optional pathspecs" },
        ...RESULT_PROPERTIES,
      },
    },
  },
  {
    name: "ecosystem_verify",
    description:
      "Check that named imports from changed files exist in the installed package entry or type declarations, and flag packages that are neither installed nor declared. With online=true it also checks newly added npm packages for first-publish age and weekly downloads. Offline by default; findings at or above fail_on_issue return exit code 1.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        diff: { type: "string", description: "Unified diff text. Omit to use the project's git diff." },
        base: { type: "string", description: "Check git diff <base>...HEAD, e.g. origin/main" },
        staged: { type: "boolean", description: "Only staged changes" },
        unstaged: { type: "boolean", description: "Only unstaged changes" },
        include_untracked: { type: "boolean", description: "Include untracked files" },
        online: { type: "boolean", description: "Check age and downloads of newly added npm packages" },
        min_age_days: { type: "integer", minimum: 1, maximum: 3650, description: "Minimum package age in days (default 30)" },
        min_downloads: {
          type: "integer",
          minimum: 1,
          maximum: 1_000_000_000,
          description: "Minimum weekly downloads (default 1000)",
        },
        fail_on_issue: {
          type: "string",
          enum: ["high", "medium", "low"],
          description: "Lowest severity that returns exit code 1",
        },
        paths: { type: "array", items: { type: "string" }, description: "Optional pathspecs" },
        ...RESULT_PROPERTIES,
      },
    },
  },
  {
    name: "pack",
    description:
      "Build a compact Markdown context bundle for a task: project rules, changed-file signatures, related references and an optional test failure excerpt, capped by budget characters. Offline and free of model calls.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["task"],
      properties: {
        task: { type: "string", description: "What the agent is trying to do" },
        diff: { type: "string", description: "Unified diff text. Omit to use the project's git diff." },
        base: { type: "string", description: "Use git diff <base>...HEAD, e.g. origin/main" },
        staged: { type: "boolean", description: "Use staged changes" },
        unstaged: { type: "boolean", description: "Use unstaged changes" },
        include_untracked: { type: "boolean", description: "Include untracked files when diffing" },
        budget: { type: "integer", minimum: 200, description: "Maximum bundle size in characters (default 20000)" },
        test_log: { type: "string", description: "Path to captured test output to append" },
        rules: { type: "string", description: "Path to a rules file; defaults to .oc-pilot/rules.md" },
        paths: { type: "array", items: { type: "string" }, description: "Optional pathspecs" },
        ...RESULT_PROPERTIES,
      },
    },
  },
  {
    name: "pack_hologram",
    description:
      "Build a layered semantic hologram of the repository: LOD 0 keeps full text for files in the diff, LOD 1 keeps direct imports with function bodies replaced by markers and EFFECTS hints, LOD 2 lists export names only. Unbalanced braces fall back to full text with [Hologram: parse bailout]. The final Markdown is secret-scanned and redacted. Offline and free of model calls.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        task: { type: "string", description: "What the agent is trying to do" },
        diff: { type: "string", description: "Unified diff text. Omit to use the project's git diff." },
        base: { type: "string", description: "Use git diff <base>...HEAD, e.g. origin/main" },
        staged: { type: "boolean", description: "Use staged changes" },
        unstaged: { type: "boolean", description: "Use unstaged changes" },
        include_untracked: { type: "boolean", description: "Include untracked files when diffing" },
        max_tokens: { type: "integer", minimum: 1000, maximum: 200000, description: "Hologram token budget (default 30000)" },
        paths: { type: "array", items: { type: "string" }, description: "Optional pathspecs" },
        ...RESULT_PROPERTIES,
      },
    },
  },
  {
    name: "zoom_symbol",
    description:
      "Return the full body of one function, class or arrow function from a file. This is the escape hatch for a hologram whose LOD 1 bodies are hidden; it reads only that file and never calls a model.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["file", "symbol"],
      properties: {
        file: { type: "string", description: "Repository-relative file path" },
        symbol: { type: "string", description: "Exported symbol name from the Zoom section" },
        ...RESULT_PROPERTIES,
      },
    },
  },
  {
    name: "invariants",
    description:
      "Check the diff against .oc-pilot/invariants.md: area-scoped rules, [CRITICAL] markers and a strict JSON model answer, cached by the hash of diff and invariants. Out-of-scope rules are skipped without a model call. Violations are warnings by default; a CRITICAL violation or strict=true returns exit code 3.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        diff: { type: "string", description: "Unified diff text. Omit to use the project's git diff." },
        base: { type: "string", description: "Check git diff <base>...HEAD" },
        staged: { type: "boolean", description: "Check staged changes" },
        unstaged: { type: "boolean", description: "Check unstaged changes" },
        include_untracked: { type: "boolean", description: "Include untracked files when diffing" },
        strict: { type: "boolean", description: "Return exit code 3 for any violation, not only CRITICAL" },
        fail_on: { type: "string", enum: ["violation"], description: "Alias for strict" },
        no_cache: { type: "boolean", description: "Bypass the local verdict cache" },
        ...RESULT_PROPERTIES,
      },
    },
  },
  {
    name: "contract_drift",
    description:
      "Detect implicit contract breakage in the diff: removed fields, optional fields that became required and changed field types in TypeScript interfaces, Zod objects, Prisma models, Pydantic models and JSON Schema. Reports where a removed field is still used in untouched files. Textual, offline and free of model calls.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        diff: { type: "string", description: "Unified diff text. Omit to use the project's git diff." },
        base: { type: "string", description: "Check git diff <base>...HEAD, e.g. origin/main" },
        staged: { type: "boolean", description: "Only staged changes" },
        unstaged: { type: "boolean", description: "Only unstaged changes" },
        include_untracked: { type: "boolean", description: "Include untracked files" },
        fail_on_drift: {
          type: "string",
          enum: ["high", "medium"],
          description: "Lowest severity that returns exit code 1",
        },
        paths: { type: "array", items: { type: "string" }, description: "Optional pathspecs" },
        ...RESULT_PROPERTIES,
      },
    },
  },
  {
    name: "anti_regression",
    description:
      "Compare added lines with lines a human explicitly deleted in git history and cite the deleting commit. Skips tests and generated files, so it catches logic and imports re-added against an earlier decision. Offline and free of model calls; fail_on_regression returns exit code 1 when a match is found.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        diff: { type: "string", description: "Unified diff text. Omit to use the project's git diff." },
        base: { type: "string", description: "Check git diff <base>...HEAD, e.g. origin/main" },
        staged: { type: "boolean", description: "Only staged changes" },
        unstaged: { type: "boolean", description: "Only unstaged changes" },
        include_untracked: { type: "boolean", description: "Include untracked files" },
        max_commits: {
          type: "integer",
          minimum: 1,
          maximum: 5000,
          description: "How far back to read git history (default 200)",
        },
        since: { type: "string", description: "Only inspect deletions since this date, e.g. 2025-01-01" },
        fail_on_regression: { type: "boolean", description: "Return exit code 1 when a re-added line is found" },
        paths: { type: "array", items: { type: "string" }, description: "Optional pathspecs" },
        ...RESULT_PROPERTIES,
      },
    },
  },
  {
    name: "boundaries",
    description:
      "Check added imports against .oc-pilot/architecture.json layer rules: a file matched by a rule's from pattern must not import anything matched by its deny list. Reports file, line, import and rule reason. Offline and free of model calls; fail_on_violation returns exit code 1 on any violation.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        diff: { type: "string", description: "Unified diff text. Omit to use the project's git diff." },
        base: { type: "string", description: "Check git diff <base>...HEAD, e.g. origin/main" },
        staged: { type: "boolean", description: "Only staged changes" },
        unstaged: { type: "boolean", description: "Only unstaged changes" },
        include_untracked: { type: "boolean", description: "Include untracked files" },
        config: {
          type: "string",
          description: "Architecture config path; defaults to .oc-pilot/architecture.json",
        },
        fail_on_violation: { type: "boolean", description: "Return exit code 1 when a boundary is crossed" },
        paths: { type: "array", items: { type: "string" }, description: "Optional pathspecs" },
        ...RESULT_PROPERTIES,
      },
    },
  },
  {
    name: "test_plan",
    description:
      "Select the test files a change can affect using the repository's import graph: changed tests, direct and transitive importers, naming conventions and symbol references. Reports changed files with no test as uncovered. Offline and free of model calls; fail_on_uncovered returns exit code 1.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        diff: { type: "string", description: "Unified diff text. Omit to use the project's git diff." },
        base: { type: "string", description: "Plan git diff <base>...HEAD, e.g. origin/main" },
        staged: { type: "boolean", description: "Only staged changes" },
        unstaged: { type: "boolean", description: "Only unstaged changes" },
        include_untracked: { type: "boolean", description: "Include untracked files" },
        strategy: {
          type: "string",
          enum: ["affected", "fast", "full"],
          description: "affected keeps direct and transitive matches, fast only high confidence, full returns every test",
        },
        max_tests: { type: "integer", minimum: 1, description: "Truncate the plan after this many tests" },
        fail_on_uncovered: { type: "boolean", description: "Return exit code 1 when a changed file has no test" },
        coverage_file: { type: "string", description: "Optional coverage report to mark changed lines without tests" },
        paths: { type: "array", items: { type: "string" }, description: "Optional pathspecs" },
        ...RESULT_PROPERTIES,
      },
    },
  },
  {
    name: "compliance_verify",
    description:
      "Verify the signed compliance manifest for the current commit: recompute its SHA-256 hash, compare the recorded commit with HEAD, check the previous-manifest hash chain and the Ed25519 signature. Read-only and offline. A missing, edited or broken-chain manifest returns exit code 1 with ok=false, not a tool error.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        manifest: { type: "string", description: "Path to a manifest; defaults to .oc-pilot/compliance/latest.json" },
        public_key: { type: "string", description: "Public key file for the signature check; defaults to .oc-pilot/receipt.pub" },
        ...RESULT_PROPERTIES,
      },
    },
  },
  {
    name: "brag",
    description:
      "Build a self-contained HTML or SVG session report from local stats, git history, the last review and the receipt: commits, lines, runs, model calls, cache hits, findings and proof. No network, no external assets, no model call. With no_paths it hides file paths and finding locations.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", description: "Report title" },
        watermark: { type: "string", description: "Footer watermark" },
        no_paths: { type: "boolean", description: "Hide file paths and finding locations" },
        since_days: { type: "integer", minimum: 1, maximum: 365, description: "History window in days (default 7)" },
        svg: { type: "boolean", description: "Return standalone SVG instead of HTML" },
        ...RESULT_PROPERTIES,
      },
    },
  },
  {
    name: "battle",
    description:
      "Run an experimental two-agent hardening loop: the coder proposes a patch (and applies it with apply=true), then the hacker reviews it and runs SAST, authorization and test-weakening checks. Repeats until no high findings remain and tests pass. Needs a configured model; apply=true needs --allow-write.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["task"],
      properties: {
        task: { type: "string", description: "What the coder should implement or fix" },
        apply: { type: "boolean", description: "Apply each patch and run tests (default false)" },
        rounds: { type: "integer", minimum: 1, maximum: 5, description: "Maximum coder/hacker rounds (default 2)" },
        command: { type: "string", description: "Test command; auto-detected when omitted" },
        context: { type: "string", description: "Extra context for both agents" },
        diff: { type: "string", description: "Unified diff text. Omit to use the project's git diff." },
        base: { type: "string" },
        staged: { type: "boolean" },
        unstaged: { type: "boolean" },
        include_untracked: { type: "boolean" },
        model: { type: "string" },
        timeout: { type: "integer", minimum: 1 },
        ...RESULT_PROPERTIES,
      },
    },
  },
  {
    name: "cleanup",
    description:
      "Build an offline cleanup plan from dependency issues and safe package.json fixes, Slop Index, environment variables missing from .env/.env.example, and weakened tests. With apply=true it applies only the safe dependency fixes. No model call; apply needs --allow-write.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        apply: { type: "boolean", description: "Apply only the safe dependency fixes (default false)" },
        fail_on_task: {
          type: "string",
          enum: ["high", "medium", "low"],
          description: "Return exit code 1 when a task at or above this severity remains",
        },
        diff: { type: "string", description: "Unified diff text. Omit to use the project's git diff." },
        base: { type: "string" },
        staged: { type: "boolean" },
        unstaged: { type: "boolean" },
        include_untracked: { type: "boolean" },
        paths: { type: "array", items: { type: "string" } },
        ...RESULT_PROPERTIES,
      },
    },
  },
  {
    name: "arch_diff",
    description:
      "Render a Mermaid diagram of architectural import changes in the diff: added internal dependencies in green and removed ones in red. Uses the static import graph, never calls a model, and is safe in read-only mode.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        diff: { type: "string", description: "Unified diff text. Omit to use the project's git diff." },
        base: { type: "string", description: "Analyze git diff <base>...HEAD, e.g. origin/main" },
        staged: { type: "boolean", description: "Analyze staged changes" },
        unstaged: { type: "boolean", description: "Analyze unstaged changes" },
        include_untracked: { type: "boolean", description: "Include untracked files when diffing" },
        max_edges: { type: "integer", minimum: 1, maximum: 2000, description: "Cap the rendered edges (default 200)" },
        fail_on_removed: { type: "boolean", description: "Return exit code 1 when an internal dependency was removed" },
        paths: { type: "array", items: { type: "string" } },
        ...RESULT_PROPERTIES,
      },
    },
  },
  {
    name: "roast",
    description:
      "Roast the diff with a toxic senior persona: technically grounded jokes about complexity, naming, needless abstraction and blind trust in AI. Every joke cites file:line and the answer ends with one real fix. It attacks code, never the author. Model-backed; no file changes.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        persona: { type: "string", enum: ["linus", "ramsay", "corporate", "default"], description: "Roast persona (default linus)" },
        context: { type: "string", description: "What happened and what deserves the roast" },
        diff: { type: "string", description: "Unified diff text. Omit to use the project's git diff." },
        base: { type: "string" },
        staged: { type: "boolean" },
        unstaged: { type: "boolean" },
        include_untracked: { type: "boolean" },
        ...RESULT_PROPERTIES,
        lang: { type: "string", enum: ["en", "ru"] },
        model: { type: "string" },
        timeout: { type: "integer", minimum: 1 },
        repo_context: { type: "boolean" },
        no_secret_scan: { type: "boolean" },
      },
    },
  },
  {
    name: "cinema",
    description:
      "Build a terminal timelapse of local activity: commits, agent runs, API calls, the last review and the receipt, rendered as a self-contained HTML player or an asciinema v2 cast. No network, no external assets, no model call. With no_paths it hides commit subjects and finding locations.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", description: "Player title" },
        since_days: { type: "integer", minimum: 1, maximum: 365, description: "History window in days (default 7)" },
        max_frames: { type: "integer", minimum: 1, maximum: 500, description: "Cap the number of frames (default 120)" },
        no_paths: { type: "boolean", description: "Hide commit subjects and finding locations" },
        cast: { type: "boolean", description: "Return an asciinema v2 cast instead of HTML" },
        ...RESULT_PROPERTIES,
      },
    },
  },
  {
    name: "bounty",
    description:
      "Build an ASCII WANTED poster for the worst file in the repository, scored offline from SAST findings, duplicated blocks, dead exports, aged TODOs and churn without tests. No model call and no network. With no_paths it hides file names and finding locations.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 20, description: "How many suspects to rank (default 5)" },
        since_days: { type: "integer", minimum: 1, maximum: 365, description: "Churn and TODO window in days (default 30)" },
        ...RESULT_PROPERTIES,
      },
    },
  },
  {
    name: "autopsy",
    description:
      "Forensic post-mortem for a commit: diff stats, SAST findings on added lines, weakened tests and mock leaks, ranked suspect files and a before/after commit timeline. Uses local git and files only, never calls a model, so it is free and safe in read-only mode. With fail_on_risk a dangerous verdict returns exit code 1, not a tool error.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        commit: { type: "string", description: "Commit or revision to autopsy (default HEAD)" },
        depth: { type: "integer", minimum: 1, maximum: 50, description: "Timeline commits to inspect (default 5)" },
        fail_on_risk: { type: "boolean", description: "Return exit code 1 when the verdict is dangerous" },
        ...RESULT_PROPERTIES,
      },
    },
  },
  {
    name: "echo",
    description:
      "Build self-contained SVG badges from local stats, git history and the receipt: commits, agent runs, API calls, cache hits, findings and test status. With submit=true and an explicit endpoint it sends an anonymous aggregate payload containing only the nickname, window and stats; no paths, diffs or secrets. No network by default, no model call.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", description: "Nickname for the badges and the leaderboard payload (default anonymous)" },
        since_days: { type: "integer", minimum: 1, maximum: 365, description: "History window in days (default 30)" },
        submit: { type: "boolean", description: "Send the anonymous payload; requires endpoint and --allow-write" },
        endpoint: { type: "string", description: "Explicit leaderboard endpoint for submit" },
        svg: { type: "boolean", description: "Return only the combined SVG sheet" },
        ...RESULT_PROPERTIES,
      },
    },
  },
  {
    name: "sast",
    description:
      "Deterministic offline SAST for changed files: command and SQL injection, path traversal, SSRF, code injection, XSS, open redirects, disabled TLS verification, wildcard CORS, prototype pollution, weak hashes and JWT none. Uses local files only and never calls a model, so it is free and safe in read-only mode. Findings at or above fail_on_issue return exit code 1, not a tool error.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        diff: { type: "string", description: "Unified diff to scan instead of the git working tree" },
        base: { type: "string", description: "Scan git diff <base>...HEAD, e.g. origin/main" },
        staged: { type: "boolean", description: "Scan staged changes" },
        unstaged: { type: "boolean", description: "Scan unstaged changes" },
        include_untracked: { type: "boolean", description: "Include untracked files when diffing" },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Files or directories to scan instead of the git diff",
        },
        fail_on_issue: {
          type: "string",
          enum: ["high", "medium", "low"],
          description: "Lowest severity that fails the gate (default high)",
        },
        ignore: { type: "array", items: { type: "string" }, description: "Rule ids to ignore" },
        no_suppressions: { type: "boolean", description: "Ignore oc-pilot:sast-ignore comments" },
        baseline: { type: "string", description: "Baseline file with accepted findings (default .oc-pilot/baseline.json)" },
        update_baseline: { type: "boolean", description: "Write current findings to the baseline and exit 0" },
        ...RESULT_PROPERTIES,
      },
    },
  },
  {
    name: "authz",
    description:
      "Offline authorization analysis of HTTP routes: handlers without a session check, IDOR (an object loaded by a request id without an ownership check) and admin paths without a role guard. Understands Express, Fastify, Koa and Next.js route files. Uses local files only and never calls a model, so it is free and safe in read-only mode. Findings at or above fail_on_issue return exit code 1, not a tool error.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        diff: { type: "string", description: "Unified diff to scan instead of the git working tree" },
        base: { type: "string", description: "Scan git diff <base>...HEAD, e.g. origin/main" },
        staged: { type: "boolean", description: "Scan staged changes" },
        unstaged: { type: "boolean", description: "Scan unstaged changes" },
        include_untracked: { type: "boolean", description: "Include untracked files when diffing" },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Files or directories to scan instead of the git diff",
        },
        fail_on_issue: {
          type: "string",
          enum: ["high", "medium"],
          description: "Lowest severity that fails the gate (default high)",
        },
        ignore: { type: "array", items: { type: "string" }, description: "Rule ids to ignore" },
        public: {
          type: "array",
          items: { type: "string" },
          description: "Route prefixes that are public by design, e.g. /health",
        },
        no_suppressions: { type: "boolean", description: "Ignore oc-pilot:authz-ignore comments" },
        baseline: { type: "string", description: "Baseline file with accepted findings (default .oc-pilot/baseline.json)" },
        update_baseline: { type: "boolean", description: "Write current findings to the baseline and exit 0" },
        ...RESULT_PROPERTIES,
      },
    },
  },
  {
    name: "preflight",
    description:
      "One offline verdict before a commit: secrets, SAST, route authorization, dependency health scoped to the change, test weakening and the Slop Index delta. Uses git and local files only and never calls a model, so it is free and safe in read-only mode. A failed check returns status fail with exit code 1, not a tool error.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        diff: { type: "string", description: "Unified diff to check instead of the git working tree" },
        base: { type: "string", description: "Check git diff <base>...HEAD, e.g. origin/main" },
        staged: { type: "boolean", description: "Check staged changes" },
        unstaged: { type: "boolean", description: "Check unstaged changes" },
        include_untracked: { type: "boolean", description: "Include untracked files when diffing" },
        since: { type: "string", description: "Slop Index baseline ref (default HEAD)" },
        max_delta: { type: "integer", description: "Allowed Slop Index growth in points (default 10)" },
        fail_on_issue: {
          type: "string",
          enum: ["high", "medium", "low"],
          description: "Lowest SAST, authz and dependency severity that fails the gate (default high)",
        },
        no_secret_scan: { type: "boolean", description: "Skip the secret scan" },
        no_sast: { type: "boolean", description: "Skip SAST" },
        no_authz: { type: "boolean", description: "Skip route authorization analysis" },
        no_deps: { type: "boolean", description: "Skip dependency health" },
        no_tests: { type: "boolean", description: "Skip test weakening" },
        no_slop: { type: "boolean", description: "Skip the Slop Index delta" },
        ...RESULT_PROPERTIES,
      },
    },
  },
  {
    name: "ready",
    description:
      "Agent readiness score 0-100 for the repository: tests, lockfile, git hooks, Slop Index, a fresh receipt, agent instructions, CI, config and security. Uses git and local files only and never calls a model, so it is free and safe in read-only mode. A score below fail_under returns exit code 1 with the full report, not a tool error.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fail_under: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Return exit code 1 when the score is below this value",
        },
        ...RESULT_PROPERTIES,
      },
    },
  },
  {
    name: "receipt_verify",
    description:
      "Verify the oc-pilot receipt for the current HEAD: recompute its SHA-256 hash, compare the recorded commit with HEAD and report whether the recorded tests passed. Read-only and offline, so it is free and safe in read-only mode. A missing, edited or stale receipt returns exit code 1 with ok=false, not a tool error.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        receipt: {
          type: "string",
          description: "Path to a receipt file; defaults to .git/oc-pilot/receipt.json",
        },
        public_key: {
          type: "string",
          description: "Public key file for the signature check; defaults to .oc-pilot/receipt.pub",
        },
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
  {
    name: "preflight-before-commit",
    title: "Gate the change before commit",
    description:
      "Run the offline preflight, fix the failed checks starting with the cheapest, and rerun until the verdict is pass or only intentional skips remain.",
    arguments: [
      { name: "context", description: "What the change is supposed to do", required: false },
    ],
  },
  {
    name: "compile-hologram",
    title: "Compile a context hologram",
    description:
      "Build a layered context where diff files are complete, direct imports hide function bodies behind markers, and the rest exposes only export names; zoom one symbol on demand instead of dumping the repo.",
    arguments: [
      { name: "context", description: "What the agent is trying to do", required: false },
    ],
  },
  {
    name: "check-invariants",
    title: "Check the semantic invariants",
    description:
      "Check the change against .oc-pilot/invariants.md, explain every violation with evidence and treat CRITICAL or strict violations as a blocking gate.",
    arguments: [
      { name: "context", description: "What the change is supposed to do", required: false },
    ],
  },
  {
    name: "fuzz-the-diff",
    title: "Fuzz the new functions",
    description:
      "Call the new exported functions with hostile inputs in isolated processes, report crashes and timeouts, and never treat blocked side-effect files as tested.",
    arguments: [
      { name: "context", description: "What the new functions are supposed to do", required: false },
    ],
  },
  {
    name: "get-ready",
    title: "Make the repository agent-ready",
    description:
      "Score the repository, fix the safe gaps (hook, config, AGENTS.md), prove the result with a receipt, and rerun until the score is at least 85 or only human checks remain.",
    arguments: [
      { name: "context", description: "What the agent is about to work on", required: false },
    ],
  },
  {
    name: "fix-security",
    title: "Fix security findings",
    description:
      "Ask oc-pilot to repair SAST or route-authorization findings, then rescan until no high findings remain.",
    arguments: [
      { name: "context", description: "What the change does and which finding matters", required: false },
    ],
  },
  {
    name: "stabilize-flaky",
    title: "Stabilize a flaky test",
    description:
      "Reproduce a flaky test with repeated and shuffled runs, identify shared state or ordering dependence, and make the smallest deterministic fix.",
    arguments: [
      { name: "context", description: "Which test is suspected and what changed recently", required: false },
    ],
  },
  {
    name: "check-impact",
    title: "Check what the change touches",
    description:
      "Find external references to changed declarations, inspect every call site, update what the change broke and rerun until no stale references remain.",
    arguments: [
      { name: "context", description: "What changed and which symbols are risky", required: false },
    ],
  },
  {
    name: "triage-deps",
    title: "Triage dependency problems",
    description:
      "Audit dependencies and vulnerabilities, fix the cheapest real problem first, and rerun without lowering the gate or hiding packages.",
    arguments: [
      { name: "context", description: "What changed and which dependency is suspect", required: false },
    ],
  },
  {
    name: "cover-changed-lines",
    title: "Cover the changed lines",
    description:
      "Measure changed-line coverage, add tests for the uncovered lines and rerun with the same gate instead of lowering the threshold.",
    arguments: [
      { name: "context", description: "Which change and behavior should be covered", required: false },
    ],
  },
  {
    name: "generate-tests",
    title: "Generate tests for the change",
    description:
      "Generate tests for changed code or only for uncovered changed lines, apply them and run the suite, fixing the patch until the tests pass.",
    arguments: [
      { name: "context", description: "What behavior the tests should protect", required: false },
    ],
  },
  {
    name: "pick-reviewers",
    title: "Pick reviewers for the change",
    description:
      "Use git history and CODEOWNERS to choose the smallest set of reviewers who know the changed files.",
    arguments: [
      { name: "context", description: "What changed and who usually owns it", required: false },
    ],
  },
  {
    name: "guard-tests",
    title: "Guard the tests against weakening",
    description:
      "Find skipped, focused or deleted tests, removed assertions, weakened matchers, suppressed type checks and swallowed assertions, then fix the cause without hiding it.",
    arguments: [
      { name: "context", description: "Why the tests changed and what they should protect", required: false },
    ],
  },
  {
    name: "sync-env",
    title: "Sync the environment variables",
    description:
      "Check every environment variable added by the change against .env and .env.example, then add the missing configuration and documentation without inventing secrets.",
    arguments: [
      { name: "context", description: "What the new variable configures and where it is read", required: false },
    ],
  },
  {
    name: "remove-mocks",
    title: "Remove stubs and hardcode",
    description:
      "Find forgotten mocks, local paths, test tokens and always-true conditions in production code, replace them with the real implementation and rerun until the leak report is clean.",
    arguments: [
      { name: "context", description: "What the code should do in production", required: false },
    ],
  },
  {
    name: "verify-ecosystem",
    title: "Verify imports and new packages",
    description:
      "Check that imported names exist in installed packages, then verify newly added npm packages against registry age and downloads before trusting them.",
    arguments: [
      { name: "context", description: "Which dependency or import is suspicious", required: false },
    ],
  },
  {
    name: "pack-context",
    title: "Pack the task context",
    description:
      "Build a compact bundle of project rules, changed-file signatures, related references and the last test failure instead of dumping whole files into the prompt.",
    arguments: [
      { name: "context", description: "What the task is supposed to change", required: false },
    ],
  },
  {
    name: "check-contracts",
    title: "Check contract drift",
    description:
      "Find removed or narrowed fields in changed types and schemas, inspect every remaining consumer and update the contract without silently breaking callers.",
    arguments: [
      { name: "context", description: "Which API or schema changed", required: false },
    ],
  },
  {
    name: "guard-regressions",
    title: "Do not re-add deleted code",
    description:
      "Compare added lines with code a human explicitly deleted, inspect the deleting commit and reintroduce a line only with an explicit reason.",
    arguments: [
      { name: "context", description: "Why the line is being added again", required: false },
    ],
  },
  {
    name: "respect-boundaries",
    title: "Keep architecture boundaries",
    description:
      "Check added imports against the layer rules, fix the direction of the dependency and rerun until no boundary is crossed.",
    arguments: [
      { name: "context", description: "Which module or layer changed", required: false },
    ],
  },
  {
    name: "plan-tests",
    title: "Plan the affected tests",
    description:
      "Select only the test files the change can affect using the import graph, then run them and cover any changed file the plan marks as untested.",
    arguments: [
      { name: "context", description: "What changed and what risk the tests should cover", required: false },
    ],
  },
  {
    name: "prove-compliance",
    title: "Prove the audit trail",
    description:
      "Verify the signed compliance manifest for HEAD, explain any broken hash, chain or signature, and refuse to claim completion while the proof is invalid.",
    arguments: [
      { name: "context", description: "What was shipped and what the audit must prove", required: false },
    ],
  },
  {
    name: "battle-hardening",
    title: "Harden the change with two agents",
    description:
      "Run the coder and hacker loop: the coder patches, the hacker attacks with review and offline security checks, and the loop repeats until no high findings remain and tests pass.",
    arguments: [
      { name: "context", description: "What the task should achieve", required: false },
    ],
  },
  {
    name: "cleanup-plan",
    title: "Plan the cleanup",
    description:
      "Build an offline cleanup plan from dependency issues, safe package.json fixes, Slop Index, environment variables and weakened tests, then fix the cheapest high tasks first.",
    arguments: [
      { name: "context", description: "What area should be cleaned up first", required: false },
    ],
  },
  {
    name: "show-arch-diff",
    title: "Show the architecture change",
    description:
      "Render a Mermaid diagram of added and removed internal dependencies, include it in the pull request and explain every removed edge instead of hiding it.",
    arguments: [
      { name: "context", description: "What the architectural change is supposed to do", required: false },
    ],
  },
  {
    name: "roast-my-code",
    title: "Roast my code",
    description:
      "Roast the current diff in the voice of a toxic senior, keep every joke tied to real code, then give one actionable fix.",
    arguments: [
      { name: "context", description: "What the change was supposed to do", required: false },
    ],
  },
  {
    name: "play-session",
    title: "Play the session back",
    description:
      "Build a terminal timelapse of recent commits, agent runs, API calls, findings and the receipt as a self-contained HTML player or asciinema cast.",
    arguments: [
      { name: "context", description: "Which session window to replay", required: false },
    ],
  },
  {
    name: "wanted-poster",
    title: "Post a bounty on the worst file",
    description:
      "Rank the most problematic files by SAST findings, duplication, dead exports, old TODOs and churn, then turn the worst one into an ASCII WANTED poster with concrete reasons.",
    arguments: [
      { name: "context", description: "Which area or file to investigate", required: false },
    ],
  },
  {
    name: "autopsy-commit",
    title: "Run a post-mortem on a commit",
    description:
      "Autopsy a commit: list the signals it introduced, rank the suspect files and read the before/after timeline to find where the protection was lost.",
    arguments: [
      { name: "context", description: "Which commit or failure to investigate", required: false },
    ],
  },
  {
    name: "share-progress",
    title: "Share local progress",
    description:
      "Build self-contained SVG badges from real local stats and the receipt, then submit the anonymous aggregate only after the user explicitly approves the endpoint.",
    arguments: [
      { name: "context", description: "What to highlight and where it may be shared", required: false },
    ],
  },
  {
    name: "prove-tests",
    title: "Prove the tests catch regressions",
    description:
      "Run mutation testing on the change, explain the surviving mutants and strengthen the tests until the mutation score is high enough.",
    arguments: [
      { name: "context", description: "What behavior the tests are supposed to protect", required: false },
    ],
  },
  {
    name: "prove-done",
    title: "Prove the work is done",
    description:
      "Verify the receipt for HEAD, create a fresh one when it is missing or stale, and refuse to claim completion until the receipt is valid and its tests passed.",
    arguments: [
      { name: "context", description: "What was changed and what should be proven", required: false },
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

/** Accepts zero and negative values, for thresholds such as a Slop Index delta. */
function signedIntegerArg(input: JsonObject, name: string): number | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ToolInputError(`${name} must be an integer`);
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

async function callTestGen(input: JsonObject, cwd: string): Promise<ToolResult> {
  const temp = new TempFiles();
  try {
    const args = ["test-gen", ...commonArgs(input, { repoContext: true, secrets: true, failOn: false }), "--json"];
    const diff = stringArg(input, "diff");
    const base = baseArg(input);
    const command = stringArg(input, "command");
    const context = contextArg(input);
    const rounds = integerArg(input, "rounds");
    const slopFiles = integerArg(input, "slop_files");
    const coverageFile = stringArg(input, "coverage_file");
    if (diff) args.push("--diff", temp.write("changes.diff", diff));
    if (base) args.push("--base", base);
    if (booleanArg(input, "staged")) args.push("--staged");
    if (booleanArg(input, "unstaged")) args.push("--unstaged");
    if (booleanArg(input, "include_untracked")) args.push("--include-untracked");
    if (booleanArg(input, "apply")) args.push("--apply");
    if (booleanArg(input, "no_run")) args.push("--no-run");
    if (booleanArg(input, "keep_failing")) args.push("--keep-failing");
    if (booleanArg(input, "force")) args.push("--force");
    if (booleanArg(input, "coverage")) args.push("--coverage");
    if (booleanArg(input, "from_slop")) args.push("--from-slop");
    if (coverageFile) args.push("--coverage-file", coverageFile);
    if (rounds !== undefined) args.push("--rounds", String(rounds));
    if (slopFiles !== undefined) args.push("--slop-files", String(slopFiles));
    if (command) args.push("--command", command);
    if (context) args.push("--context", context);
    args.push(...projectPaths(input, "paths"));
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
    if (booleanArg(input, "from_sast")) args.push("--from-sast");
    if (booleanArg(input, "from_authz")) args.push("--from-authz");
    if (rounds !== undefined) args.push("--rounds", String(rounds));
    args.push(...projectPaths(input, "paths"));
    return toToolResult(await runCli(args, cwd));
  } finally {
    temp.cleanup();
  }
}

async function callFuzz(input: JsonObject, cwd: string): Promise<ToolResult> {
  const temp = new TempFiles();
  try {
    const args = ["fuzz", "--json"];
    const diff = stringArg(input, "diff");
    const base = baseArg(input);
    if (diff) args.push("--diff", temp.write("changes.diff", diff));
    if (base) args.push("--base", base);
    if (booleanArg(input, "staged")) args.push("--staged");
    if (booleanArg(input, "unstaged")) args.push("--unstaged");
    if (booleanArg(input, "include_untracked")) args.push("--include-untracked");
    const duration = integerArg(input, "duration_ms");
    if (duration !== undefined) args.push("--duration", `${String(duration)}ms`);
    const memory = integerArg(input, "memory_mb");
    if (memory !== undefined) args.push("--memory-limit", `${String(memory)}MB`);
    const maxTargets = integerArg(input, "max_targets");
    if (maxTargets !== undefined) args.push("--max-targets", String(maxTargets));
    if (booleanArg(input, "fail_on_crash")) args.push("--fail-on-crash");
    return toToolResult(await runCli(args, cwd));
  } finally {
    temp.cleanup();
  }
}

async function callMutate(input: JsonObject, cwd: string): Promise<ToolResult> {
  const temp = new TempFiles();
  try {
    const args = ["mutate", "--json"];
    const diff = stringArg(input, "diff");
    const base = baseArg(input);
    const command = stringArg(input, "command");
    if (diff) args.push("--diff", temp.write("changes.diff", diff));
    if (base) args.push("--base", base);
    if (booleanArg(input, "staged")) args.push("--staged");
    if (booleanArg(input, "unstaged")) args.push("--unstaged");
    if (booleanArg(input, "include_untracked")) args.push("--include-untracked");
    if (command) args.push("--command", command);
    const maxMutants = integerArg(input, "max_mutants");
    if (maxMutants !== undefined) args.push("--max-mutants", String(maxMutants));
    const minScore = integerArg(input, "min_score");
    if (minScore !== undefined) args.push("--min-score", String(minScore));
    args.push(...projectPaths(input, "paths"));
    return toToolResult(await runCli(args, cwd));
  } finally {
    temp.cleanup();
  }
}

async function callFlaky(input: JsonObject, cwd: string): Promise<ToolResult> {
  const args = ["flaky", "--json"];
  const runs = integerArg(input, "runs");
  const command = stringArg(input, "command");
  const seed = stringArg(input, "seed");
  if (runs !== undefined) args.push("--runs", String(runs));
  if (command) args.push("--command", command);
  if (booleanArg(input, "fail_on_flaky")) args.push("--fail-on-flaky");
  if (booleanArg(input, "shuffle")) args.push("--shuffle");
  if (seed) args.push("--seed", seed);
  return toToolResult(await runCli(args, cwd));
}

async function callImpact(input: JsonObject, cwd: string): Promise<ToolResult> {
  const temp = new TempFiles();
  try {
    const args = ["impact", "--json"];
    const diff = stringArg(input, "diff");
    const base = baseArg(input);
    if (diff) args.push("--diff", temp.write("changes.diff", diff));
    if (base) args.push("--base", base);
    if (booleanArg(input, "staged")) args.push("--staged");
    if (booleanArg(input, "unstaged")) args.push("--unstaged");
    if (booleanArg(input, "include_untracked")) args.push("--include-untracked");
    args.push(...projectPaths(input, "paths"));
    return toToolResult(await runCli(args, cwd));
  } finally {
    temp.cleanup();
  }
}

async function callDeps(input: JsonObject, cwd: string): Promise<ToolResult> {
  const args = ["deps", "--json"];
  const why = stringArg(input, "why");
  const failOnIssue = stringArg(input, "fail_on_issue");
  const failOnVuln = stringArg(input, "fail_on_vuln");
  const osvUrl = stringArg(input, "osv_url");
  const sbom = stringArg(input, "sbom");
  if (why) args.push("--why", why);
  if (failOnIssue) args.push("--fail-on-issue", failOnIssue);
  if (failOnVuln) args.push("--fail-on-vuln", failOnVuln);
  if (osvUrl) args.push("--osv-url", osvUrl);
  if (sbom) args.push("--sbom", sbom);
  if (booleanArg(input, "audit")) args.push("--audit");
  if (booleanArg(input, "offline")) args.push("--offline");
  if (booleanArg(input, "fix")) args.push("--fix");
  const ignore = stringArrayArg(input, "ignore");
  if (ignore.length > 0) args.push("--ignore", ignore.join(","));
  return toToolResult(await runCli(args, cwd));
}

async function callCoverage(input: JsonObject, cwd: string): Promise<ToolResult> {
  const temp = new TempFiles();
  try {
    const args = ["coverage", "--json"];
    const diff = stringArg(input, "diff");
    const base = baseArg(input);
    const coverageFile = stringArg(input, "coverage_file");
    if (diff) args.push("--diff", temp.write("changes.diff", diff));
    if (base) args.push("--base", base);
    if (booleanArg(input, "staged")) args.push("--staged");
    if (booleanArg(input, "unstaged")) args.push("--unstaged");
    if (booleanArg(input, "include_untracked")) args.push("--include-untracked");
    if (coverageFile) args.push("--coverage-file", coverageFile);
    const failUnder = integerArg(input, "fail_under");
    if (failUnder !== undefined) args.push("--fail-under", String(failUnder));
    const maxUncovered = signedIntegerArg(input, "max_uncovered");
    if (maxUncovered !== undefined) args.push(`--max-uncovered=${maxUncovered}`);
    args.push(...projectPaths(input, "paths"));
    return toToolResult(await runCli(args, cwd));
  } finally {
    temp.cleanup();
  }
}

async function callReviewers(input: JsonObject, cwd: string): Promise<ToolResult> {
  const temp = new TempFiles();
  try {
    const args = ["reviewers", "--json"];
    const diff = stringArg(input, "diff");
    const base = baseArg(input);
    if (diff) args.push("--diff", temp.write("changes.diff", diff));
    if (base) args.push("--base", base);
    if (booleanArg(input, "staged")) args.push("--staged");
    if (booleanArg(input, "unstaged")) args.push("--unstaged");
    if (booleanArg(input, "include_untracked")) args.push("--include-untracked");
    const limit = integerArg(input, "limit");
    if (limit !== undefined) args.push("--limit", String(limit));
    const depth = integerArg(input, "depth");
    if (depth !== undefined) args.push("--depth", String(depth));
    const exclude = stringArrayArg(input, "exclude");
    if (exclude.length > 0) args.push("--exclude", exclude.join(","));
    args.push(...projectPaths(input, "paths"));
    return toToolResult(await runCli(args, cwd));
  } finally {
    temp.cleanup();
  }
}

async function callTestGuard(input: JsonObject, cwd: string): Promise<ToolResult> {
  const temp = new TempFiles();
  try {
    const args = ["test-guard", "--json"];
    const diff = stringArg(input, "diff");
    const base = baseArg(input);
    if (diff) args.push("--diff", temp.write("changes.diff", diff));
    if (base) args.push("--base", base);
    if (booleanArg(input, "staged")) args.push("--staged");
    if (booleanArg(input, "unstaged")) args.push("--unstaged");
    if (booleanArg(input, "include_untracked")) args.push("--include-untracked");
    if (booleanArg(input, "fail_on_weakening")) args.push("--fail-on-weakening");
    args.push(...projectPaths(input, "paths"));
    return toToolResult(await runCli(args, cwd));
  } finally {
    temp.cleanup();
  }
}

async function callEnvSync(input: JsonObject, cwd: string): Promise<ToolResult> {
  const temp = new TempFiles();
  try {
    const args = ["env-sync", "--json"];
    const diff = stringArg(input, "diff");
    const base = baseArg(input);
    if (diff) args.push("--diff", temp.write("changes.diff", diff));
    if (base) args.push("--base", base);
    if (booleanArg(input, "staged")) args.push("--staged");
    if (booleanArg(input, "unstaged")) args.push("--unstaged");
    if (booleanArg(input, "include_untracked")) args.push("--include-untracked");
    if (booleanArg(input, "fail_on_missing")) args.push("--fail-on-missing");
    args.push(...projectPaths(input, "paths"));
    return toToolResult(await runCli(args, cwd));
  } finally {
    temp.cleanup();
  }
}

async function callMockLeak(input: JsonObject, cwd: string): Promise<ToolResult> {
  const temp = new TempFiles();
  try {
    const args = ["mock-leak", "--json"];
    const diff = stringArg(input, "diff");
    const base = baseArg(input);
    if (diff) args.push("--diff", temp.write("changes.diff", diff));
    if (base) args.push("--base", base);
    if (booleanArg(input, "staged")) args.push("--staged");
    if (booleanArg(input, "unstaged")) args.push("--unstaged");
    if (booleanArg(input, "include_untracked")) args.push("--include-untracked");
    const failOn = stringArg(input, "fail_on_leak");
    if (failOn) args.push("--fail-on-leak", failOn);
    args.push(...projectPaths(input, "paths"));
    return toToolResult(await runCli(args, cwd));
  } finally {
    temp.cleanup();
  }
}

async function callEcosystemVerify(input: JsonObject, cwd: string): Promise<ToolResult> {
  const temp = new TempFiles();
  try {
    const args = ["ecosystem-verify", "--json"];
    const diff = stringArg(input, "diff");
    const base = baseArg(input);
    if (diff) args.push("--diff", temp.write("changes.diff", diff));
    if (base) args.push("--base", base);
    if (booleanArg(input, "staged")) args.push("--staged");
    if (booleanArg(input, "unstaged")) args.push("--unstaged");
    if (booleanArg(input, "include_untracked")) args.push("--include-untracked");
    if (booleanArg(input, "online")) args.push("--online");
    const minAgeDays = integerArg(input, "min_age_days");
    if (minAgeDays !== undefined) args.push("--min-age-days", String(minAgeDays));
    const minDownloads = integerArg(input, "min_downloads");
    if (minDownloads !== undefined) args.push("--min-downloads", String(minDownloads));
    const failOn = stringArg(input, "fail_on_issue");
    if (failOn) args.push("--fail-on-issue", failOn);
    args.push(...projectPaths(input, "paths"));
    return toToolResult(await runCli(args, cwd));
  } finally {
    temp.cleanup();
  }
}

async function callPack(input: JsonObject, cwd: string): Promise<ToolResult> {
  const temp = new TempFiles();
  try {
    const task = stringArg(input, "task", true)!;
    const args = ["pack", task, "--json"];
    const diff = stringArg(input, "diff");
    const base = baseArg(input);
    if (diff) args.push("--diff", temp.write("changes.diff", diff));
    if (base) args.push("--base", base);
    if (booleanArg(input, "staged")) args.push("--staged");
    if (booleanArg(input, "unstaged")) args.push("--unstaged");
    if (booleanArg(input, "include_untracked")) args.push("--include-untracked");
    const budget = integerArg(input, "budget");
    if (budget !== undefined) args.push("--budget", String(budget));
    const testLog = stringArg(input, "test_log");
    if (testLog) args.push("--test-log", testLog);
    const rules = stringArg(input, "rules");
    if (rules) args.push("--rules", rules);
    args.push(...projectPaths(input, "paths"));
    return toToolResult(await runCli(args, cwd));
  } finally {
    temp.cleanup();
  }
}

async function callPackHologram(input: JsonObject, cwd: string): Promise<ToolResult> {
  const temp = new TempFiles();
  try {
    const args = ["pack", "--hologram", "--json"];
    const task = stringArg(input, "task");
    if (task) args.push(task);
    const diff = stringArg(input, "diff");
    const base = baseArg(input);
    if (diff) args.push("--diff", temp.write("changes.diff", diff));
    if (base) args.push("--base", base);
    if (booleanArg(input, "staged")) args.push("--staged");
    if (booleanArg(input, "unstaged")) args.push("--unstaged");
    if (booleanArg(input, "include_untracked")) args.push("--include-untracked");
    const maxTokens = integerArg(input, "max_tokens");
    if (maxTokens !== undefined) args.push("--max-tokens", String(maxTokens));
    args.push(...projectPaths(input, "paths"));
    return toToolResult(await runCli(args, cwd));
  } finally {
    temp.cleanup();
  }
}

async function callZoomSymbol(input: JsonObject, cwd: string): Promise<ToolResult> {
  const file = stringArg(input, "file", true)!;
  const symbol = stringArg(input, "symbol", true)!;
  return toToolResult(await runCli(["zoom-symbol", file, symbol, "--json"], cwd));
}

async function callInvariants(input: JsonObject, cwd: string): Promise<ToolResult> {
  const temp = new TempFiles();
  try {
    const args = ["invariants", "--json"];
    const diff = stringArg(input, "diff");
    const base = baseArg(input);
    if (diff) args.push("--diff", temp.write("changes.diff", diff));
    if (base) args.push("--base", base);
    if (booleanArg(input, "staged")) args.push("--staged");
    if (booleanArg(input, "unstaged")) args.push("--unstaged");
    if (booleanArg(input, "include_untracked")) args.push("--include-untracked");
    if (booleanArg(input, "strict")) args.push("--strict");
    const failOn = stringArg(input, "fail_on");
    if (failOn) args.push("--fail-on", failOn);
    if (booleanArg(input, "no_cache")) args.push("--no-cache");
    return toToolResult(await runCli(args, cwd));
  } finally {
    temp.cleanup();
  }
}

async function callContractDrift(input: JsonObject, cwd: string): Promise<ToolResult> {
  const temp = new TempFiles();
  try {
    const args = ["contract-drift", "--json"];
    const diff = stringArg(input, "diff");
    const base = baseArg(input);
    if (diff) args.push("--diff", temp.write("changes.diff", diff));
    if (base) args.push("--base", base);
    if (booleanArg(input, "staged")) args.push("--staged");
    if (booleanArg(input, "unstaged")) args.push("--unstaged");
    if (booleanArg(input, "include_untracked")) args.push("--include-untracked");
    const failOn = stringArg(input, "fail_on_drift");
    if (failOn) args.push("--fail-on-drift", failOn);
    args.push(...projectPaths(input, "paths"));
    return toToolResult(await runCli(args, cwd));
  } finally {
    temp.cleanup();
  }
}

async function callAntiRegression(input: JsonObject, cwd: string): Promise<ToolResult> {
  const temp = new TempFiles();
  try {
    const args = ["anti-regression", "--json"];
    const diff = stringArg(input, "diff");
    const base = baseArg(input);
    if (diff) args.push("--diff", temp.write("changes.diff", diff));
    if (base) args.push("--base", base);
    if (booleanArg(input, "staged")) args.push("--staged");
    if (booleanArg(input, "unstaged")) args.push("--unstaged");
    if (booleanArg(input, "include_untracked")) args.push("--include-untracked");
    const maxCommits = integerArg(input, "max_commits");
    if (maxCommits !== undefined) args.push("--max-commits", String(maxCommits));
    const since = stringArg(input, "since");
    if (since) args.push("--since", since);
    if (booleanArg(input, "fail_on_regression")) args.push("--fail-on-regression");
    args.push(...projectPaths(input, "paths"));
    return toToolResult(await runCli(args, cwd));
  } finally {
    temp.cleanup();
  }
}

async function callBoundaries(input: JsonObject, cwd: string): Promise<ToolResult> {
  const temp = new TempFiles();
  try {
    const args = ["boundaries", "--json"];
    const diff = stringArg(input, "diff");
    const base = baseArg(input);
    const config = stringArg(input, "config");
    if (diff) args.push("--diff", temp.write("changes.diff", diff));
    if (base) args.push("--base", base);
    if (booleanArg(input, "staged")) args.push("--staged");
    if (booleanArg(input, "unstaged")) args.push("--unstaged");
    if (booleanArg(input, "include_untracked")) args.push("--include-untracked");
    if (config) args.push("--config", config);
    if (booleanArg(input, "fail_on_violation")) args.push("--fail-on-violation");
    args.push(...projectPaths(input, "paths"));
    return toToolResult(await runCli(args, cwd));
  } finally {
    temp.cleanup();
  }
}

async function callTestPlan(input: JsonObject, cwd: string): Promise<ToolResult> {
  const temp = new TempFiles();
  try {
    const args = ["test-plan", "--json"];
    const diff = stringArg(input, "diff");
    const base = baseArg(input);
    const strategy = stringArg(input, "strategy");
    const coverageFile = stringArg(input, "coverage_file");
    if (diff) args.push("--diff", temp.write("changes.diff", diff));
    if (base) args.push("--base", base);
    if (booleanArg(input, "staged")) args.push("--staged");
    if (booleanArg(input, "unstaged")) args.push("--unstaged");
    if (booleanArg(input, "include_untracked")) args.push("--include-untracked");
    if (strategy) args.push("--strategy", strategy);
    const maxTests = integerArg(input, "max_tests");
    if (maxTests !== undefined) args.push("--max-tests", String(maxTests));
    if (booleanArg(input, "fail_on_uncovered")) args.push("--fail-on-uncovered");
    if (coverageFile) args.push("--coverage-file", coverageFile);
    args.push(...projectPaths(input, "paths"));
    return toToolResult(await runCli(args, cwd));
  } finally {
    temp.cleanup();
  }
}

async function callComplianceVerify(input: JsonObject, cwd: string): Promise<ToolResult> {
  const args = ["compliance", "--verify", "--json"];
  const manifest = stringArg(input, "manifest");
  const publicKey = stringArg(input, "public_key");
  if (manifest) args.push("--manifest", manifest);
  if (publicKey) args.push("--public-key", publicKey);
  return toToolResult(await runCli(args, cwd));
}

async function callBrag(input: JsonObject, cwd: string): Promise<ToolResult> {
  const args = ["brag", "--json"];
  const title = stringArg(input, "title");
  const watermark = stringArg(input, "watermark");
  const sinceDays = integerArg(input, "since_days");
  if (title) args.push("--title", title);
  if (watermark) args.push("--watermark", watermark);
  if (booleanArg(input, "no_paths")) args.push("--no-paths");
  if (sinceDays !== undefined) args.push("--since-days", String(sinceDays));
  if (booleanArg(input, "svg")) args.push("--svg");
  return toToolResult(await runCli(args, cwd));
}

async function callBattle(input: JsonObject, cwd: string): Promise<ToolResult> {
  const temp = new TempFiles();
  try {
    const task = stringArg(input, "task", true)!;
    const args = ["battle", task, "--json"];
    const diff = stringArg(input, "diff");
    const base = baseArg(input);
    const command = stringArg(input, "command");
    const context = stringArg(input, "context");
    const rounds = integerArg(input, "rounds");
    if (diff) args.push("--diff", temp.write("changes.diff", diff));
    if (base) args.push("--base", base);
    if (booleanArg(input, "staged")) args.push("--staged");
    if (booleanArg(input, "unstaged")) args.push("--unstaged");
    if (booleanArg(input, "include_untracked")) args.push("--include-untracked");
    if (command) args.push("--command", command);
    if (context) args.push("--context", context);
    if (rounds !== undefined) args.push("--rounds", String(rounds));
    if (booleanArg(input, "apply")) args.push("--apply");
    const model = stringArg(input, "model");
    if (model) args.push("--model", model);
    const timeout = integerArg(input, "timeout");
    if (timeout !== undefined) args.push("--timeout", String(timeout));
    return toToolResult(await runCli(args, cwd));
  } finally {
    temp.cleanup();
  }
}

async function callCleanup(input: JsonObject, cwd: string): Promise<ToolResult> {
  const temp = new TempFiles();
  try {
    const args = ["cleanup", "--json"];
    const diff = stringArg(input, "diff");
    const base = baseArg(input);
    const failOnTask = stringArg(input, "fail_on_task");
    if (diff) args.push("--diff", temp.write("changes.diff", diff));
    if (base) args.push("--base", base);
    if (booleanArg(input, "staged")) args.push("--staged");
    if (booleanArg(input, "unstaged")) args.push("--unstaged");
    if (booleanArg(input, "include_untracked")) args.push("--include-untracked");
    if (failOnTask) args.push("--fail-on-task", failOnTask);
    if (booleanArg(input, "apply")) args.push("--apply");
    args.push(...projectPaths(input, "paths"));
    return toToolResult(await runCli(args, cwd));
  } finally {
    temp.cleanup();
  }
}

async function callArchDiff(input: JsonObject, cwd: string): Promise<ToolResult> {
  const temp = new TempFiles();
  try {
    const args = ["arch-diff", "--json"];
    const diff = stringArg(input, "diff");
    const base = baseArg(input);
    if (diff) args.push("--diff", temp.write("changes.diff", diff));
    if (base) args.push("--base", base);
    if (booleanArg(input, "staged")) args.push("--staged");
    if (booleanArg(input, "unstaged")) args.push("--unstaged");
    if (booleanArg(input, "include_untracked")) args.push("--include-untracked");
    const maxEdges = integerArg(input, "max_edges");
    if (maxEdges !== undefined) args.push("--max-edges", String(maxEdges));
    if (booleanArg(input, "fail_on_removed")) args.push("--fail-on-removed");
    args.push(...projectPaths(input, "paths"));
    return toToolResult(await runCli(args, cwd));
  } finally {
    temp.cleanup();
  }
}

async function callRoast(input: JsonObject, cwd: string): Promise<ToolResult> {
  const temp = new TempFiles();
  try {
    const args = ["roast", ...commonArgs(input, { repoContext: true, secrets: true, failOn: false }), "--json"];
    const diff = stringArg(input, "diff");
    const base = baseArg(input);
    const context = contextArg(input);
    const persona = stringArg(input, "persona");
    if (diff) args.push("--diff", temp.write("changes.diff", diff));
    if (base) args.push("--base", base);
    if (booleanArg(input, "staged")) args.push("--staged");
    if (booleanArg(input, "unstaged")) args.push("--unstaged");
    if (booleanArg(input, "include_untracked")) args.push("--include-untracked");
    if (context) args.push("--context", context);
    if (persona) args.push("--persona", persona);
    return toToolResult(await runCli(args, cwd));
  } finally {
    temp.cleanup();
  }
}

async function callCinema(input: JsonObject, cwd: string): Promise<ToolResult> {
  const args = ["cinema", "--json"];
  const title = stringArg(input, "title");
  const sinceDays = integerArg(input, "since_days");
  const maxFrames = integerArg(input, "max_frames");
  if (title) args.push("--title", title);
  if (sinceDays !== undefined) args.push("--since-days", String(sinceDays));
  if (maxFrames !== undefined) args.push("--max-frames", String(maxFrames));
  if (booleanArg(input, "no_paths")) args.push("--no-paths");
  if (booleanArg(input, "cast")) args.push("--cast");
  return toToolResult(await runCli(args, cwd));
}

async function callBounty(input: JsonObject, cwd: string): Promise<ToolResult> {
  const args = ["bounty", "--json"];
  const limit = integerArg(input, "limit");
  const sinceDays = integerArg(input, "since_days");
  if (limit !== undefined) args.push("--limit", String(limit));
  if (sinceDays !== undefined) args.push("--since-days", String(sinceDays));
  return toToolResult(await runCli(args, cwd));
}

async function callAutopsy(input: JsonObject, cwd: string): Promise<ToolResult> {
  const args = ["autopsy", stringArg(input, "commit") ?? "HEAD", "--json"];
  const depth = integerArg(input, "depth");
  if (depth !== undefined) args.push("--depth", String(depth));
  if (booleanArg(input, "fail_on_risk")) args.push("--fail-on-risk");
  return toToolResult(await runCli(args, cwd));
}

async function callEcho(input: JsonObject, cwd: string): Promise<ToolResult> {
  const args = ["echo", "--json"];
  const name = stringArg(input, "name");
  const sinceDays = integerArg(input, "since_days");
  const endpoint = stringArg(input, "endpoint");
  if (name) args.push("--name", name);
  if (sinceDays !== undefined) args.push("--since-days", String(sinceDays));
  if (booleanArg(input, "submit")) args.push("--submit");
  if (endpoint) args.push("--endpoint", endpoint);
  if (booleanArg(input, "svg")) args.push("--svg");
  return toToolResult(await runCli(args, cwd));
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

async function callPreflight(input: JsonObject, cwd: string): Promise<ToolResult> {
  const temp = new TempFiles();
  try {
    const args = ["preflight", "--json"];
    const diff = stringArg(input, "diff");
    const base = baseArg(input);
    if (diff) args.push("--diff", temp.write("changes.diff", diff));
    if (base) args.push("--base", base);
    if (booleanArg(input, "staged")) args.push("--staged");
    if (booleanArg(input, "unstaged")) args.push("--unstaged");
    if (booleanArg(input, "include_untracked")) args.push("--include-untracked");
    const since = stringArg(input, "since");
    if (since) args.push("--since", since);
    const maxDelta = signedIntegerArg(input, "max_delta");
    if (maxDelta !== undefined) args.push(`--max-delta=${maxDelta}`);
    const failOn = stringArg(input, "fail_on_issue");
    if (failOn) args.push("--fail-on-issue", failOn);
    if (booleanArg(input, "no_secret_scan")) args.push("--no-secret-scan");
    if (booleanArg(input, "no_sast")) args.push("--no-sast");
    if (booleanArg(input, "no_authz")) args.push("--no-authz");
    if (booleanArg(input, "no_deps")) args.push("--no-deps");
    if (booleanArg(input, "no_tests")) args.push("--no-tests");
    if (booleanArg(input, "no_slop")) args.push("--no-slop");
    args.push(...projectPaths(input, "paths"));
    return toToolResult(await runCli(args, cwd));
  } finally {
    temp.cleanup();
  }
}

async function callSast(input: JsonObject, cwd: string): Promise<ToolResult> {
  const temp = new TempFiles();
  try {
    const args = ["sast", "--json"];
    const diff = stringArg(input, "diff");
    const base = baseArg(input);
    if (diff) args.push("--diff", temp.write("changes.diff", diff));
    if (base) args.push("--base", base);
    if (booleanArg(input, "staged")) args.push("--staged");
    if (booleanArg(input, "unstaged")) args.push("--unstaged");
    if (booleanArg(input, "include_untracked")) args.push("--include-untracked");
    const failOn = stringArg(input, "fail_on_issue");
    if (failOn) args.push("--fail-on-issue", failOn);
    const ignore = stringArrayArg(input, "ignore");
    if (ignore.length > 0) args.push("--ignore", ignore.join(","));
    if (booleanArg(input, "no_suppressions")) args.push("--no-suppressions");
    const baseline = stringArg(input, "baseline");
    if (baseline) args.push("--baseline", baseline);
    if (booleanArg(input, "update_baseline")) args.push("--update-baseline");
    args.push(...projectPaths(input, "paths"));
    return toToolResult(await runCli(args, cwd));
  } finally {
    temp.cleanup();
  }
}

async function callAuthz(input: JsonObject, cwd: string): Promise<ToolResult> {
  const temp = new TempFiles();
  try {
    const args = ["authz", "--json"];
    const diff = stringArg(input, "diff");
    const base = baseArg(input);
    if (diff) args.push("--diff", temp.write("changes.diff", diff));
    if (base) args.push("--base", base);
    if (booleanArg(input, "staged")) args.push("--staged");
    if (booleanArg(input, "unstaged")) args.push("--unstaged");
    if (booleanArg(input, "include_untracked")) args.push("--include-untracked");
    const failOn = stringArg(input, "fail_on_issue");
    if (failOn) args.push("--fail-on-issue", failOn);
    const ignore = stringArrayArg(input, "ignore");
    if (ignore.length > 0) args.push("--ignore", ignore.join(","));
    const publicRoutes = stringArrayArg(input, "public");
    if (publicRoutes.length > 0) args.push("--public", publicRoutes.join(","));
    if (booleanArg(input, "no_suppressions")) args.push("--no-suppressions");
    const baseline = stringArg(input, "baseline");
    if (baseline) args.push("--baseline", baseline);
    if (booleanArg(input, "update_baseline")) args.push("--update-baseline");
    args.push(...projectPaths(input, "paths"));
    return toToolResult(await runCli(args, cwd));
  } finally {
    temp.cleanup();
  }
}

async function callReady(input: JsonObject, cwd: string): Promise<ToolResult> {
  const args = ["ready", "--json"];
  const failUnder = signedIntegerArg(input, "fail_under");
  if (failUnder !== undefined) args.push(`--fail-under=${String(failUnder)}`);
  return toToolResult(await runCli(args, cwd));
}

async function callReceiptVerify(input: JsonObject, cwd: string): Promise<ToolResult> {
  const args = ["receipt", "--verify", "--json"];
  const receipt = stringArg(input, "receipt");
  if (receipt) args.push("--receipt", receipt);
  const publicKey = stringArg(input, "public_key");
  if (publicKey) args.push("--public-key", publicKey);
  return toToolResult(await runCli(args, cwd));
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
    if ((name === "sast" || name === "authz") && booleanArg(input, "update_baseline")) {
      throw new ToolInputError("updating a baseline is disabled in read-only mode; start the MCP server with --allow-write");
    }
    if (name === "mutate") {
      throw new ToolInputError("mutation testing rewrites source files temporarily and is disabled in read-only mode; start the MCP server with --allow-write");
    }
    if (name === "battle" && booleanArg(input, "apply")) {
      throw new ToolInputError("battle apply rewrites the working tree and is disabled in read-only mode; start the MCP server with --allow-write");
    }
    if (name === "cleanup" && booleanArg(input, "apply")) {
      throw new ToolInputError("cleanup apply rewrites package.json and is disabled in read-only mode; start the MCP server with --allow-write");
    }
    if (name === "echo" && booleanArg(input, "submit")) {
      throw new ToolInputError("echo submit sends telemetry and is disabled in read-only mode; start the MCP server with --allow-write");
    }
    if (name === "test_gen" && booleanArg(input, "apply")) {
      throw new ToolInputError("test_gen apply writes test files and is disabled in read-only mode; start the MCP server with --allow-write");
    }
    if (name === "deps" && (booleanArg(input, "fix") || stringArg(input, "sbom"))) {
      throw new ToolInputError("deps fix and sbom write files and are disabled in read-only mode; start the MCP server with --allow-write");
    }
  }
  switch (name) {
    case "review":
      return callReview(input, cwd);
    case "test_fix":
      return callTestFix(input, cwd);
    case "test_gen":
      return callTestGen(input, cwd);
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
    case "mutate":
      return callMutate(input, cwd);
    case "fuzz":
      return callFuzz(input, cwd);
    case "flaky":
      return callFlaky(input, cwd);
    case "impact":
      return callImpact(input, cwd);
    case "deps":
      return callDeps(input, cwd);
    case "coverage":
      return callCoverage(input, cwd);
    case "reviewers":
      return callReviewers(input, cwd);
    case "test_guard":
      return callTestGuard(input, cwd);
    case "env_sync":
      return callEnvSync(input, cwd);
    case "mock_leak":
      return callMockLeak(input, cwd);
    case "ecosystem_verify":
      return callEcosystemVerify(input, cwd);
    case "pack":
      return callPack(input, cwd);
    case "pack_hologram":
      return callPackHologram(input, cwd);
    case "zoom_symbol":
      return callZoomSymbol(input, cwd);
    case "invariants":
      return callInvariants(input, cwd);
    case "contract_drift":
      return callContractDrift(input, cwd);
    case "anti_regression":
      return callAntiRegression(input, cwd);
    case "boundaries":
      return callBoundaries(input, cwd);
    case "test_plan":
      return callTestPlan(input, cwd);
    case "compliance_verify":
      return callComplianceVerify(input, cwd);
    case "brag":
      return callBrag(input, cwd);
    case "battle":
      return callBattle(input, cwd);
    case "cleanup":
      return callCleanup(input, cwd);
    case "arch_diff":
      return callArchDiff(input, cwd);
    case "roast":
      return callRoast(input, cwd);
    case "cinema":
      return callCinema(input, cwd);
    case "bounty":
      return callBounty(input, cwd);
    case "autopsy":
      return callAutopsy(input, cwd);
    case "echo":
      return callEcho(input, cwd);
    case "preflight":
      return callPreflight(input, cwd);
    case "sast":
      return callSast(input, cwd);
    case "authz":
      return callAuthz(input, cwd);
    case "ready":
      return callReady(input, cwd);
    case "receipt_verify":
      return callReceiptVerify(input, cwd);
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
  if (Array.isArray(value.results) && typeof value.crashes === "number" && Array.isArray(value.targets)) {
    return `oc-pilot: fuzz ${String(value.targets.length)} target(s), ${String(value.crashes)} crash(es), ${String(value.blocked ?? 0)} blocked, ${String(value.timeouts ?? 0)} timeout(s)`;
  }
  if (Array.isArray(value.verdicts) && typeof value.violations === "number" && typeof value.checked === "number") {
    return `oc-pilot: invariants ${String(value.checked)} checked, ${String(value.skipped ?? 0)} skipped, ${String(value.violations)} violation(s)`;
  }
  if (Array.isArray(value.files) && typeof value.estimatedTokens === "number" && typeof value.maxTokens === "number") {
    return `oc-pilot: hologram ${String(value.files.length)} file(s), ~${String(value.estimatedTokens)} tokens (max ${String(value.maxTokens)})`;
  }
  if (typeof value.symbol === "string" && typeof value.body === "string" && typeof value.line === "number") {
    const file = typeof value.file === "string" ? value.file : "?";
    return `oc-pilot: symbol ${file}#${value.symbol} (line ${String(value.line)})`;
  }
  if (Array.isArray(value.badges) && asObject(value.stats)) {
    const stats = asObject(value.stats)!;
    const name = typeof value.name === "string" ? value.name : "anonymous";
    return `oc-pilot: ${String(value.badges.length)} badge(s) for ${name}, ${String(stats.commits ?? 0)} commits, ${String(stats.runs ?? 0)} runs`;
  }
  if (typeof value.verdict === "string" && Array.isArray(value.signals) && asObject(value.commit)) {
    const commit = asObject(value.commit)!;
    const short = typeof commit.shortHash === "string" ? commit.shortHash : "unknown";
    return `oc-pilot: autopsy ${value.verdict} for ${short}, ${String(value.signals.length)} signal(s)`;
  }
  if (Array.isArray(value.candidates) && typeof value.score === "number" && (typeof value.file === "string" || value.file === null)) {
    if (typeof value.file === "string") {
      return `oc-pilot: worst file ${value.file} (${String(value.score)} points, ${String(value.candidates.length)} suspect${value.candidates.length === 1 ? "" : "s"})`;
    }
    return `oc-pilot: no bounty (${String(value.scannedFiles ?? 0)} files scanned)`;
  }
  if (Array.isArray(value.frames) && typeof value.sinceDays === "number" && typeof value.format === "string") {
    const frames = String(value.frames.length);
    const days = String(value.sinceDays);
    const format = value.format === "cast" ? "cast" : "HTML";
    return `oc-pilot: ${frames} frame${frames === "1" ? "" : "s"} over ${days} day${days === "1" ? "" : "s"} (${format})`;
  }
  if (typeof value.index === "number") {
    return `oc-pilot: Slop Index ${value.index}/100 (${String(value.grade ?? "unknown")})`;
  }
  if (Array.isArray(value.added) && Array.isArray(value.removed) && typeof value.diagram === "string") {
    const added = String(value.added.length);
    const removed = String(value.removed.length);
    return `oc-pilot: ${added} added edge${added === "1" ? "" : "s"}, ${removed} removed edge${removed === "1" ? "" : "s"}`;
  }
  if (Array.isArray(value.tasks) && asObject(value.counts)) {
    const counts = asObject(value.counts)!;
    return `oc-pilot: ${String(counts.total)} cleanup task(s), ${String(counts.high)} high, ${String(counts.medium)} medium`;
  }
  if (typeof value.status === "string" && Array.isArray(value.rounds)) {
    const rounds = String(value.rounds.length);
    return `oc-pilot: battle ${value.status}, ${rounds} round${rounds === "1" ? "" : "s"}`;
  }
  if (typeof value.chars === "number" && typeof value.budget === "number" && Array.isArray(value.files)) {
    const files = String(value.files.length);
    const state = value.truncated === true ? "truncated" : "within budget";
    return `oc-pilot: ${files} file${files === "1" ? "" : "s"}, ${String(value.chars)} chars (${state})`;
  }
  const reportStats = asObject(value.stats);
  if (reportStats && typeof reportStats.commits === "number" && typeof reportStats.runs === "number" && typeof value.content === "string") {
    const findings = asObject(reportStats.findings);
    const total =
      (typeof findings?.critical === "number" ? findings.critical : 0) +
      (typeof findings?.warning === "number" ? findings.warning : 0) +
      (typeof findings?.style === "number" ? findings.style : 0);
    const format = value.content.trimStart().startsWith("<svg") ? "SVG" : "HTML";
    return `oc-pilot: ${String(reportStats.commits)} commits, ${String(reportStats.runs)} runs, ${String(total)} findings (${format})`;
  }
  const verification = asObject(value.verification);
  if (verification && typeof verification.ok === "boolean") {
    const state = verification.ok ? "ok" : "failed";
    const commit = typeof verification.commit === "string" ? verification.commit.slice(0, 12) : "unknown";
    return `oc-pilot: compliance ${state} for ${commit}`;
  }
  if (typeof value.strategy === "string" && Array.isArray(value.tests) && Array.isArray(value.uncovered)) {
    const tests = String(value.tests.length);
    const uncovered = String(value.uncovered.length);
    return `oc-pilot: ${tests} test file${tests === "1" ? "" : "s"} selected, ${uncovered} uncovered changed file${uncovered === "1" ? "" : "s"}`;
  }
  if (Array.isArray(value.references) && Array.isArray(value.missing) && Array.isArray(value.undocumented)) {
    const references = String(value.references.length);
    const missing = String(value.missing.length);
    const undocumented = String(value.undocumented.length);
    return `oc-pilot: ${references} env reference${references === "1" ? "" : "s"}, ${missing} missing, ${undocumented} undocumented`;
  }
  if (Array.isArray(value.violations) && typeof value.rules === "number" && typeof value.scannedFiles === "number") {
    const violations = String(value.violations.length);
    const files = String(new Set(value.violations.map((item) => asObject(item)?.file).filter(Boolean)).size);
    return `oc-pilot: ${violations} boundary violation${violations === "1" ? "" : "s"} in ${files} file${files === "1" ? "" : "s"}`;
  }
  if (Array.isArray(value.findings) && typeof value.checkedLines === "number") {
    const hashes = new Set<string>();
    for (const finding of value.findings) {
      const commit = asObject(asObject(finding)?.commit);
      if (typeof commit?.hash === "string") hashes.add(commit.hash);
    }
    const lines = String(value.findings.length);
    const commits = String(hashes.size);
    return `oc-pilot: ${lines} re-added line${lines === "1" ? "" : "s"}, ${commits} commit${commits === "1" ? "" : "s"}`;
  }
  const counts = asObject(value.counts);
  if (
    counts &&
    typeof counts.high === "number" &&
    typeof counts.medium === "number" &&
    Array.isArray(value.contracts) &&
    Array.isArray(value.findings)
  ) {
    const total = String(value.findings.length);
    return `oc-pilot: ${total} contract drift${total === "1" ? "" : "s"}, ${String(counts.high)} high, ${String(counts.medium)} medium`;
  }
  if (
    counts &&
    typeof counts.high === "number" &&
    typeof counts.medium === "number" &&
    typeof counts.low === "number" &&
    Array.isArray(value.issues)
  ) {
    const total = String(value.issues.length);
    return `oc-pilot: ${total} ecosystem issue${total === "1" ? "" : "s"}, ${String(counts.high)} high, ${String(counts.medium)} medium`;
  }
  if (
    counts &&
    typeof counts.high === "number" &&
    typeof counts.medium === "number" &&
    typeof counts.low === "number" &&
    Array.isArray(value.findings)
  ) {
    const total = String(value.findings.length);
    return `oc-pilot: ${total} mock leak${total === "1" ? "" : "s"}, ${String(counts.high)} high, ${String(counts.medium)} medium`;
  }
  if (counts && typeof counts.total === "number" && Array.isArray(value.findings)) {
    const total = String(counts.total);
    return `oc-pilot: ${total} test weakening finding${total === "1" ? "" : "s"}, status ${String(value.status ?? "unknown")}`;
  }
  if (typeof value.status === "string" && typeof value.rounds === "number" && Array.isArray(value.files)) {
    const files = String(value.files.length);
    return `oc-pilot: tests ${value.status}, ${files} file${files === "1" ? "" : "s"}, ${String(value.rounds)} round${value.rounds === 1 ? "" : "s"}`;
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
  if (Array.isArray(value.flaky) && typeof value.runs === "number") {
    const flaky = String(value.flaky.length);
    const failing = Array.isArray(value.failing) ? String(value.failing.length) : "0";
    return `oc-pilot: ${flaky} flaky, ${failing} failing across ${String(value.runs)} runs`;
  }
  if (typeof value.packageName === "string" && Array.isArray(value.issues) && typeof value.declared === "number") {
    const issues = String(value.issues.length);
    const audit = asObject(value.audit);
    const vulnerabilities = Array.isArray(audit?.vulnerabilities) ? String(audit.vulnerabilities.length) : "0";
    return `oc-pilot: ${issues} dependency issue${issues === "1" ? "" : "s"}, ${vulnerabilities} vulnerabilit${vulnerabilities === "1" ? "y" : "ies"} (${String(value.declared)} declared, ${String(value.imported)} imported)`;
  }
  if (Array.isArray(value.symbols) && Array.isArray(value.references) && typeof value.scannedFiles === "number") {
    const symbols = String(value.symbols.length);
    const references = String(value.references.length);
    const scanned = String(value.scannedFiles);
    return `oc-pilot: ${symbols} changed symbol${symbols === "1" ? "" : "s"}, ${references} reference${references === "1" ? "" : "s"} in ${scanned} scanned file${scanned === "1" ? "" : "s"}`;
  }
  if (Array.isArray(value.candidates) && Array.isArray(value.codeowners) && Array.isArray(value.files)) {
    const reviewers = String(value.candidates.length);
    const owners = String(value.codeowners.length);
    const files = String(value.files.length);
    return `oc-pilot: ${reviewers} reviewer candidate${reviewers === "1" ? "" : "s"}, ${owners} CODEOWNERS owner${owners === "1" ? "" : "s"} for ${files} file${files === "1" ? "" : "s"}`;
  }
  if (typeof value.uncoveredLines === "number" && Array.isArray(value.gaps)) {
    const files = value.gaps.length;
    const percent = typeof value.coveragePercent === "number" ? ` (${String(value.coveragePercent)}%)` : "";
    return `oc-pilot: ${String(value.uncoveredLines)} uncovered changed line${value.uncoveredLines === 1 ? "" : "s"} in ${String(files)} file${files === 1 ? "" : "s"}${percent}`;
  }
  if (typeof value.score === "number" && typeof value.survived === "number") {
    const score = String(value.score);
    const survived = String(value.survived);
    return `oc-pilot: mutation score ${score}/100, ${survived} survived`;
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
    case "preflight-before-commit":
      return `Before I commit, call the oc-pilot "preflight" tool with staged=true. It runs offline: secrets, dependency health scoped to the change, test weakening and the Slop Index delta. If the verdict is fail, fix the cheapest failing check first, then call "preflight" again. Do not disable a check with no_* flags or lower the gate just to get a pass. When it passes, report what was checked and any remaining skips.${suffix}`;
    case "compile-hologram":
      return `Call the oc-pilot "pack_hologram" tool with max_tokens=30000 and the current diff. The result is layered: LOD 0 files are complete, LOD 1 bodies are hidden behind markers, LOD 2 lists export names. Never invent a hidden body: if the implementation matters, call "zoom_symbol" with the file and symbol from the Zoom section and read the returned body before reasoning about it. Treat [Hologram: parse bailout] as a warning that the file is complete. Do not dump the whole repository or raise max_tokens just to avoid zooming; the hologram exists to save context. Report which files were LOD 0/1/2, any redacted secrets and every symbol you zoomed.${suffix}`;
    case "check-invariants":
      return `Call the oc-pilot "invariants" tool on the current diff with strict=false first. Read every verdict: [SKIPPED: Out of scope] rules were not checked and must not be reported as passed; [UNKNOWN] means the model lacked evidence. For each violation, quote the file:line and explain which invariant broke. Do not edit .oc-pilot/invariants.md, do not delete a rule to get a pass and do not hide a CRITICAL violation. If the user wants a hard gate, rerun with strict=true and report exit code 3. After a fix, rerun the tool and compare the verdicts.${suffix}`;
    case "fuzz-the-diff":
      return `Call the oc-pilot "fuzz" tool with duration_ms=2000, memory_mb=128 and fail_on_crash=true. Read every result: [CRASH] is a real unhandled input and needs a minimal fix plus a regression test; [TIMEOUT] is an infinite loop or pathological complexity; [BLOCKED] and [SKIPPED] were not executed and must not be reported as safe. Never remove the side-effect guard, never run the function in the main process and never widen the memory or timeout limits just to hide a crash. After the fix, rerun the same tool and compare.${suffix}`;
    case "get-ready":
      return `Call the oc-pilot "ready" tool with fail_under=85. If the score is below the threshold, fix the cheapest gap first: install the pre-commit hook for hooks, create AGENTS.md for docs, add .oc-pilot.json for config, run the suite for tests, and run oc-pilot receipt for the receipt check. Do not lower fail_under to get a pass. Rerun "ready" until the score is at least 85 or only checks that need a human remain, then report the score, the fixed items and the remaining gaps.${suffix}`;
    case "fix-security":
      return `Call the oc-pilot "fix" tool with from_sast=true (or from_authz=true for route authorization) and apply=true. It asks the model for a patch that removes the findings, applies it, runs the tests and rescans; the result reports sast or authz as {before, after, remaining}. If the server is read-only, call the same tool without apply, show the patch and ask me to apply it. Do not add suppressions, do not edit .oc-pilot/baseline.json, and do not claim success while remaining is above zero. If high findings remain, report them with file:line and the smallest next step.${suffix}`;
    case "stabilize-flaky":
      return `Call the oc-pilot "flaky" tool with runs=5 and shuffle=true (the command must contain {files}; pass a fixed seed when you have one). If it reports no flaky tests, say so and stop. For each flaky test, inspect shared state, ordering, time, randomness and network assumptions, then make the smallest deterministic fix in the test or its setup. Never hide the problem with retries, sleeps, longer timeouts, skipped tests or by reordering files. Rerun with the same seed and runs to prove the test is stable. Report the test names, the cause, the fix and the before/after evidence.${suffix}`;
    case "check-impact":
      return `Call the oc-pilot "impact" tool on the current diff. It lists the declarations the change added or removed and every untouched file that still mentions those names. Inspect each reference: update call sites, imports, types, docs and tests that the change invalidated. Do not rename a public symbol or delete a call site only to make the report empty, and remember the search is textual, so confirm each hit before editing. Rerun "impact" after the edits and report the changed symbols, the files updated and any references you deliberately left.${suffix}`;
    case "triage-deps":
      return `Call the oc-pilot "deps" tool with audit=true, offline=false, fail_on_issue=medium and fail_on_vuln=high. Separate real problems from noise: a phantom import, a missing declaration, an unused package, a floating version, a broken lockfile, then a vulnerability. Fix the cheapest real problem first and rerun the same call. Never add an ignore, lower a gate or remove a dependency only to silence the report; if a vulnerability has no fixed version, say so and propose a mitigation. If the server is read-only, show the planned package.json change and ask me to apply it. Report what was fixed, what remains and the exact versions.${suffix}`;
    case "cover-changed-lines":
      return `Call the oc-pilot "coverage" tool on the current diff with fail_under=80 (or max_uncovered=0 when the project has no meaningful percentage). Add tests that execute the uncovered changed lines, then call "coverage" again with the same gate. Do not lower the threshold, add coverage-ignore comments, or delete the uncovered branch only to get a pass. Report the covered percentage, the files and lines you covered, and any gap you deliberately left.${suffix}`;
    case "generate-tests":
      return `Call the oc-pilot "test_gen" tool with apply=true, coverage=true and a coverage_file when one exists. Without a coverage report it targets the changed code; with from_slop=true it targets untested files instead. The tool writes only test files, runs the suite and reverts failing tests. If the server is read-only, call it without apply, show the patch and ask me to apply it. Do not edit production code, weaken assertions, add skips or change the test command only to get a pass. Rerun until status is pass, then report the files, rounds, test results and any coverage gaps that remain.${suffix}`;
    case "pick-reviewers":
      return `Call the oc-pilot "reviewers" tool on the current diff. Use the candidates and CODEOWNERS owners to choose the smallest set of reviewers who actually know the changed files. Do not add bots or people only because they committed once; explain each choice with the files and commit counts, and say when the history is too thin to be useful.${suffix}`;
    case "guard-tests":
      return `Call the oc-pilot "test_guard" tool on the current diff with fail_on_weakening=true. For every finding, restore the protection or fix the production cause: remove skips and focus, restore deleted assertions, replace existence checks with the original strict matcher, remove @ts-ignore and empty catch blocks, and bring timeouts back. Never add skip/focus, delete a test, weaken a matcher, suppress a type error or swallow an assertion to get a pass. Rerun "test_guard" until status is pass, then report each finding and the real fix.${suffix}`;
    case "sync-env":
      return `Call the oc-pilot "env_sync" tool on the current diff with fail_on_missing=true. Add every missing variable to the real configuration and every new variable to .env.example (and .env.sample or .env.template when the project uses them). Document what each variable configures and which value a human must supply; never invent production secrets, never commit a real .env with secrets, and never delete a reference only to silence the report. Rerun "env_sync" until status is pass, then report the variables, files and any value the human still has to provide.${suffix}`;
    case "remove-mocks":
      return `Call the oc-pilot "mock_leak" tool on the current diff with fail_on_leak=medium. For every finding, replace the stub with the real implementation: wire the actual request or service, take the local path and host from configuration, load the secret from the environment, and delete always-true or always-false branches instead of keeping dead code. Never move a mock into a comment, rename it to hide it, add an ignore marker or delete the production call to silence the report. Rerun "mock_leak" until status is pass, then report each finding, the file and the real behavior that replaced it.${suffix}`;
    case "verify-ecosystem":
      return `Call the oc-pilot "ecosystem_verify" tool on the current diff with fail_on_issue=high, and add online=true when the change introduces a new package. For a missing export, correct the call to the real API of the installed version or install and declare the package that actually provides it; never replace the import with any or a local shim only to silence the report. For a package that is missing, too new or has too few downloads, stop and ask me before installing it. Rerun offline until status is pass, then report each package, the missing names, the files and the online evidence you used.${suffix}`;
    case "pack-context":
      return `Call the oc-pilot "pack" tool with the task and the current diff. Use only the returned bundle instead of dumping whole files into the prompt, and ask for more context only when a named signature or file is missing. Do not treat the pack as proof that the code is correct; run the checks after the change.${suffix}`;
    case "check-contracts":
      return `Call the oc-pilot "contract_drift" tool on the current diff with fail_on_drift=high. For every finding, inspect the listed consumers and either update them to the new shape or keep a compatible field, alias or migration. Do not silently rename or delete a field, and do not edit the contract only to make the report empty. Rerun "contract_drift" until no high findings remain, then report each contract, field, consumer and the compatibility decision.${suffix}`;
    case "guard-regressions":
      return `Call the oc-pilot "anti_regression" tool on the current diff with fail_on_regression=true. Every finding is a line a human already deleted, with the commit that removed it. Read that commit and the surrounding change before deciding: reintroduce the line only when the original reason no longer applies or the task explicitly requires it, and say why. Never rewrite the line only to dodge the exact match, never rewrite git history, and never suppress the finding. Rerun until status is pass, then report each commit, file:line and the decision.${suffix}`;
    case "respect-boundaries":
      return `Call the oc-pilot "boundaries" tool with fail_on_violation=true. If it reports violations, fix the dependency direction instead of widening the rule: move shared logic behind a service or interface, inject the dependency, or move the file into the allowed layer. Change .oc-pilot/architecture.json only when the architecture intentionally changed, and say why. Never rename or ignore an import just to dodge the check. Rerun until it passes and report each violation, the file:line and the fix.${suffix}`;
    case "plan-tests":
      return `Call the oc-pilot "test_plan" tool with strategy=affected and fail_on_uncovered=true on the current change. Run only the returned test files, not the whole suite. For every file in uncovered, add the smallest test that exercises the changed behavior or explain why it cannot be tested here. Do not lower the strategy, delete a test, or run the full suite just to hide an uncovered file. Rerun "test_plan" after adding tests and report the selected files, the reasons, the tests you ran and any remaining uncovered files.${suffix}`;
    case "prove-compliance":
      return `Call the oc-pilot "compliance_verify" tool for HEAD. A valid proof has ok=true, hashOk=true, chainOk=true, commitOk=true and a signature that is valid or unchecked because no public key is available. If the manifest is missing, create one with oc-pilot compliance (and sign it when a key exists), then verify again. Never edit a manifest, never reorder the chain and never claim completion while ok is false; report the exact reason and the commit.${suffix}`;
    case "battle-hardening":
      return `Call the oc-pilot "battle" tool with the task and apply=true when the server has write access. It alternates a coder patch with a hacker review plus SAST, authorization and test-weakening checks, and stops only when no high findings remain and the tests pass. Do not lower rounds, skip the hacker, or hide findings to reach a pass. If the status is fail or stopped, report the round, the finding source and the smallest next step. If the server is read-only, call battle without apply and show the proposed patch.${suffix}`;
    case "cleanup-plan":
      return `Call the oc-pilot "cleanup" tool with fail_on_task=high. Fix the high and medium tasks in order: dependency issues and safe package.json fixes first, then environment variables, weakened tests and the Slop Index. Use apply=true only for the safe dependency fixes and only when the server is writable; for code changes make the smallest real fix yourself. Do not delete tests, suppress environment variables, ignore dependencies or lower the gate to get a pass. Rerun "cleanup" and report the applied fixes and the tasks that still need a human.${suffix}`;
    case "show-arch-diff":
      return `Call the oc-pilot "arch_diff" tool on the current diff. Put the returned Mermaid block into the pull request description so reviewers see the architecture change: green edges were added, red dashed edges were removed. For every removed edge, explain why the dependency disappeared and whether the behavior moved elsewhere. Do not hide a removed edge, hand-edit the diagram or widen max_edges only to make the picture look smaller. If the tool reports truncation, say so.${suffix}`;
    case "roast-my-code":
      return `Call the oc-pilot "roast" tool on the current diff with the persona the user asked for (default linus). Use the returned roast as-is, or sharpen the wording without inventing code that is not in the diff. Keep every joke tied to file:line and finish with the single most valuable fix. Never turn the roast into personal harassment, slurs or threats.${suffix}`;
    case "play-session":
      return `Call the oc-pilot "cinema" tool with since_days=30 and max_frames=120 (or cast=true for asciinema). Present the returned player as a replay of real local activity: commits, agent runs, API calls, findings and the receipt. Do not invent frames, hide failed runs or claim the timelapse proves correctness; it is a report, not a test. Report the format, the frame count, the window and any gaps in the history.${suffix}`;
    case "wanted-poster":
      return `Call the oc-pilot "bounty" tool with limit=5 and since_days=30. Present the WANTED poster as a playful but factual ranking, then explain the reasons behind the worst file in plain language and name the single highest-weight reason to fix first. Do not invent issues, shame people or paste the poster into a public channel without checking the file names; do not rewrite production code just to lower the score. After a fix, call "bounty" again and compare the score.${suffix}`;
    case "autopsy-commit":
      return `Call the oc-pilot "autopsy" tool for the commit (default HEAD) with depth=5 and fail_on_risk=true. Read the signals, the ranked suspects and the before/after timeline: identify which added line introduced each signal and which earlier commit removed a protection. Propose the smallest fix and the test that would have caught it. Do not blame authors, rewrite git history, hide signals or change the timeline; after the fix, call "autopsy" again and compare. Report the commit, verdict, signal file:line and timeline evidence.${suffix}`;
    case "share-progress":
      return `Call the oc-pilot "echo" tool with since_days=30 and the nickname the user chose. Show the SVG badges and the exact aggregate payload. Do not call submit=true unless the user explicitly approved the endpoint; the payload must contain only nickname, window and aggregates, never paths, diffs, secrets or finding text. If the user approves, call "echo" again with submit=true and that endpoint, then report the status. Never invent numbers, inflate badges or claim a leaderboard rank you did not receive.${suffix}`;
    case "prove-tests":
      return `Call the oc-pilot "mutate" tool on the current change with max_mutants=20 and min_score=80. Each surviving mutant is a behavior the tests do not protect: add or strengthen the smallest test that would kill it, then call "mutate" again. Do not change production code only to satisfy a mutant, do not weaken assertions, and do not lower min_score to get a pass. Report the mutation score, the surviving mutants with file:line, and the tests you added.${suffix}`;
    case "prove-done":
      return `Do not say the work is done yet. Call the oc-pilot "receipt_verify" tool. A valid proof has ok=true, hashOk=true, stale=false and tests.passed=true for the current HEAD. If the receipt is missing, stale or reports failing tests, run the suite and create a fresh receipt with oc-pilot receipt, then call "receipt_verify" again. Use oc-pilot receipt --no-run only when tests cannot run here, and say so explicitly. Never edit a receipt by hand and never claim completion while ok is false or tests.passed is false. Report the receipt path, the commit and what was verified.${suffix}`;
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
        `oc-pilot analyzes diffs and failing tests. Tools return JSON; secret values are redacted before model calls whenever possible. Prompts (prompts/list) wrap the common flows: review my diff, fix failing tests, pre-commit gate, security review, agent readiness, prove done. Read-only context is also exposed as resources (oc-pilot://config, oc-pilot://rules, oc-pilot://prompt/en|ru, oc-pilot://version) and resource templates (oc-pilot://diff/{mode}, oc-pilot://scan/{mode}, oc-pilot://file/{+path}). Offline tools (scan, stats, slop, sast, authz, preflight, ready, receipt_verify) never call a model and keep working even after the call budget is exhausted; oc-pilot://slop exposes the Slop Index report and the slop-check prompt frames the entropy question.${readOnly ? " This server is read-only: fix apply, commit apply, running new tests and clearing stats are disabled." : ""}`,
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
            text: `Tool budget exhausted (${maxToolCalls} model-backed calls per session). Restart the server to reset, raise --max-calls, or use the offline tools: scan, stats, slop, sast, authz, preflight, ready, receipt_verify.`,
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

The offline tools (scan, stats, slop, sast, authz, preflight, ready, receipt_verify) never call a model and keep working
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
