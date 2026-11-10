import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnalysisResult } from "../types.js";
import { PilotError } from "./errors.js";
import { log } from "./log.js";
import { killProcessTree } from "./process.js";

export interface OpenCodeRunOptions {
  /** Agent system prompt. */
  systemPrompt: string;
  /** User message containing the INPUT schema. */
  input: string;
  cwd: string;
  model?: string;
  agent?: string;
  timeoutMs: number;
  verbose?: boolean;
  /** Allow the built-in agent to read repository files with read/glob/grep. */
  repoContext: boolean;
}

interface JsonEvent {
  type?: string;
  sessionID?: string;
  part?: {
    text?: string;
    cost?: number;
  };
  error?: unknown;
}

export const BUILTIN_AGENT = "oc-pilot";

interface PreparedRun {
  cwd: string;
  agent?: string;
  message: string;
  standalone: boolean;
  env: NodeJS.ProcessEnv;
  cleanup?: () => void;
}

/**
 * Quotes one argv element for the Windows `cmd.exe` command line. The opencode
 * CLI ships as a `.cmd` shim there, so the command has to go through a shell.
 * Windows programs parse their command line with the C runtime rules:
 * backslashes are literal, but a run of them doubles when it precedes an
 * embedded quote, and a trailing run doubles before the closing quote.
 */
export function quoteShellArg(value: string): string {
  // A backslash is safe while unquoted, but a trailing run would swallow the
  // closing quote once we add one, so that case goes through the escape path.
  if (/^[-A-Za-z0-9_./:@#%+=,\\]+$/.test(value) && !value.endsWith("\\")) {
    return value;
  }
  const escaped = value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/, "$1$1");
  return `"${escaped}"`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    const data = record.data;
    if (data && typeof data === "object" && typeof (data as Record<string, unknown>).message === "string") {
      return String((data as Record<string, unknown>).message);
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

interface PermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny";
}

const DENY_ALL_PERMISSIONS: PermissionRule[] = [{ action: "*", resource: "*", effect: "deny" }];

const READ_ONLY_PERMISSIONS: PermissionRule[] = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  // Never expose credentials, keys or VCS internals to the model. Last rule wins.
  { action: "read", resource: "*.env", effect: "deny" },
  { action: "read", resource: "*.env.*", effect: "deny" },
  { action: "read", resource: "*.env.example", effect: "allow" },
  { action: "read", resource: "*.pem", effect: "deny" },
  { action: "read", resource: "*.key", effect: "deny" },
  { action: "read", resource: "*.p12", effect: "deny" },
  { action: "read", resource: "*.pfx", effect: "deny" },
  { action: "read", resource: "*.jks", effect: "deny" },
  { action: "read", resource: "*id_rsa*", effect: "deny" },
  { action: "read", resource: "*id_ed25519*", effect: "deny" },
  { action: "read", resource: "*.npmrc", effect: "deny" },
  { action: "read", resource: "*.pypirc", effect: "deny" },
  { action: "read", resource: "*.netrc", effect: "deny" },
  { action: "read", resource: "*/.ssh/*", effect: "deny" },
  { action: "read", resource: "*/.aws/*", effect: "deny" },
  { action: "read", resource: "*/.git/*", effect: "deny" },
  { action: "external_directory", resource: "*", effect: "deny" },
];

export interface AgentDefinition {
  description: string;
  mode: "primary";
  steps: number;
  system: string;
  permissions: PermissionRule[];
}

export function buildAgentDefinition(systemPrompt: string, repoContext: boolean): AgentDefinition {
  return {
    description: repoContext
      ? "oc-pilot code analysis (read-only repository context)"
      : "oc-pilot code analysis (diff only, tools disabled)",
    mode: "primary",
    steps: repoContext ? 8 : 2,
    system: systemPrompt,
    permissions: repoContext ? READ_ONLY_PERMISSIONS : DENY_ALL_PERMISSIONS,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Injects the built-in agent into OPENCODE_CONFIG_CONTENT. Existing inline
 * config is preserved so user-level providers, models and plugins keep working.
 */
export function buildConfigContent(systemPrompt: string, repoContext: boolean): string {
  let base: Record<string, unknown> = {};
  const existing = process.env.OPENCODE_CONFIG_CONTENT;
  if (existing && existing.trim()) {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (isRecord(parsed)) base = parsed;
      else log.warn("OPENCODE_CONFIG_CONTENT не является JSON-объектом; используется конфиг oc-pilot.");
    } catch {
      log.warn("OPENCODE_CONFIG_CONTENT содержит некорректный JSON; используется конфиг oc-pilot.");
    }
  }

  const agents = isRecord(base.agents) ? base.agents : {};
  base.agents = {
    ...agents,
    [BUILTIN_AGENT]: buildAgentDefinition(systemPrompt, repoContext),
  };

  return JSON.stringify(base);
}

/**
 * The built-in agent gets a real OpenCode system prompt. With repository
 * context it runs in the analyzed project with read/glob/grep allowed and every
 * other tool denied; with --no-repo-context it keeps the previous isolated
 * temp-project behavior and cannot read anything.
 *
 * An explicitly configured third-party agent receives the combined prompt as a
 * user message and keeps its own permissions.
 */
function prepareRun(options: OpenCodeRunOptions): PreparedRun {
  const agent = options.agent?.trim() || BUILTIN_AGENT;
  const baseEnv = {
    ...process.env,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };

  if (agent !== BUILTIN_AGENT) {
    return {
      cwd: options.cwd,
      agent,
      message: `${options.systemPrompt}\n\n=== INPUT ===\n${options.input}\n=== END INPUT ===`,
      standalone: false,
      env: baseEnv,
    };
  }

  if (options.repoContext) {
    return {
      cwd: options.cwd,
      agent: BUILTIN_AGENT,
      message: options.input,
      standalone: true,
      env: {
        ...baseEnv,
        OPENCODE_CONFIG_CONTENT: buildConfigContent(options.systemPrompt, true),
      },
    };
  }

  const tempDir = mkdtempSync(join(tmpdir(), "oc-pilot-"));
  const agentDir = join(tempDir, ".opencode", "agents");
  const frontmatter = `---
description: oc-pilot standalone code analysis (tools disabled)
mode: primary
steps: 2
permissions:
  - action: "*"
    resource: "*"
    effect: deny
---
`;
  try {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, `${BUILTIN_AGENT}.md`), `${frontmatter}\n${options.systemPrompt}\n`, "utf8");
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw new PilotError(`Не удалось подготовить агента ${BUILTIN_AGENT}`, {
      hint: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    cwd: tempDir,
    agent: BUILTIN_AGENT,
    message: options.input,
    standalone: false,
    env: baseEnv,
    cleanup: () => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Temp cleanup is best-effort.
      }
    },
  };
}

/**
 * Runs `opencode run --format json`, feeds the message through stdin (avoiding
 * Windows command-line length limits), and extracts assistant text events.
 */
export function runOpenCode(options: OpenCodeRunOptions): Promise<AnalysisResult> {
  const prepared = prepareRun(options);

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const args = prepared.standalone
      ? ["--standalone", "run", "--format", "json"]
      : ["run", "--format", "json"];
    if (options.model) args.push("--model", options.model);
    if (prepared.agent) args.push("--agent", prepared.agent);

    const windowsCommand = ["opencode", ...args].map(quoteShellArg).join(" ");
    const child =
      process.platform === "win32"
        ? spawn(windowsCommand, {
            cwd: prepared.cwd,
            shell: true, // oc-pilot:sast-ignore shell-true: Windows требует shell для запуска .cmd-обёртки opencode
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
            env: prepared.env,
          })
        : spawn("opencode", args, {
            cwd: prepared.cwd,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
            env: prepared.env,
          });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    const textParts: string[] = [];
    let rawOutput = "";
    let sessionID: string | undefined;
    let cost: number | undefined;
    const errors: string[] = [];
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const settle = (error: Error | undefined, result?: AnalysisResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else if (result) resolve(result);
    };

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let event: JsonEvent;
      try {
        event = JSON.parse(trimmed) as JsonEvent;
      } catch {
        rawOutput += `${trimmed}\n`;
        return;
      }

      if (event.sessionID) sessionID = event.sessionID;

      if (event.type === "text" && typeof event.part?.text === "string") {
        textParts.push(event.part.text);
        return;
      }

      if (event.type === "step_finish" && typeof event.part?.cost === "number") {
        cost = event.part.cost;
        return;
      }

      if (event.type === "error") {
        errors.push(errorMessage(event.error));
      }
    };

    const flushLines = (): void => {
      let newline = stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        handleLine(stdoutBuffer.slice(0, newline));
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        newline = stdoutBuffer.indexOf("\n");
      }
    };

    timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, options.timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      flushLines();
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrBuffer += chunk;
      if (stderrBuffer.length > 40_000) stderrBuffer = stderrBuffer.slice(-40_000);
      if (options.verbose) {
        for (const line of chunk.split(/\r?\n/)) {
          if (line.trim()) log.detail(`opencode: ${line}`);
        }
      }
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      prepared.cleanup?.();
      if (error.code === "ENOENT") {
        settle(
          new PilotError("OpenCode CLI не найден в PATH", {
            hint: "Установите OpenCode (https://opencode.ai) и проверьте: opencode --version",
          }),
        );
        return;
      }
      settle(new PilotError(`Не удалось запустить OpenCode: ${error.message}`));
    });

    child.on("close", (code) => {
      prepared.cleanup?.();
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
      const durationMs = Date.now() - startedAt;

      if (timedOut) {
        settle(
          new PilotError(`OpenCode не ответил за ${Math.round(options.timeoutMs / 1000)} с`, {
            hint: "Увеличьте --timeout или проверьте доступность модели.",
          }),
        );
        return;
      }

      if (code !== 0) {
        const details = [
          ...errors,
          ...(stderrBuffer.trim() ? [stderrBuffer.trim().split("\n").slice(-8).join("\n")] : []),
        ];
        settle(
          new PilotError(`OpenCode завершился с кодом ${code ?? "unknown"}`, {
            hint:
              details.length > 0
                ? details.join("\n")
                : "Проверьте авторизацию и доступность модели: opencode auth list",
          }),
        );
        return;
      }

      let text = textParts
        .map((part) => part.trim())
        .filter(Boolean)
        .join("\n\n")
        .trim();
      if (!text && rawOutput.trim()) text = rawOutput.trim();
      if (!text) {
        settle(
          new PilotError("OpenCode не вернул текст ответа", {
            hint: errors.length > 0 ? errors.join("\n") : stderrBuffer.trim() || undefined,
          }),
        );
        return;
      }

      if (errors.length > 0) {
        log.warn(`OpenCode сообщил об ошибке, но вернул ответ: ${errors.join(" | ")}`);
      }

      settle(undefined, {
        text,
        sessionID,
        cost,
        durationMs,
        stderr: stderrBuffer,
      });
    });

    child.stdin?.on("error", (error) => {
      prepared.cleanup?.();
      settle(new PilotError(`Не удалось передать промпт в OpenCode: ${error.message}`));
    });

    child.stdin?.write(prepared.message);
    child.stdin?.end();
  });
}
