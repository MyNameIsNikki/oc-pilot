import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PilotError } from "../core/errors.js";
import { log } from "../core/log.js";
import { parseCommandArgs, type OptionSpec } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";
import { VERSION } from "../version.js";

type JsonObject = Record<string, unknown>;

type ClientId = "claude" | "cursor" | "opencode" | "codex" | "gemini" | "vscode" | "windsurf";

const CLIENT_NAMES: Record<ClientId, string> = {
  claude: "Claude Code",
  cursor: "Cursor",
  opencode: "OpenCode",
  codex: "OpenAI Codex CLI",
  gemini: "Gemini CLI",
  vscode: "VS Code / Copilot",
  windsurf: "Windsurf",
};

const DEFAULT_CLIENTS: ClientId[] = ["claude", "cursor", "opencode", "vscode"];
const ALL_CLIENTS: ClientId[] = ["claude", "cursor", "opencode", "codex", "gemini", "vscode", "windsurf"];

const OPTIONS: OptionSpec = {
  cwd: { type: "string", short: "C" },
  client: { type: "string", multiple: true },
  all: { type: "boolean" },
  global: { type: "boolean" },
  print: { type: "boolean" },
  force: { type: "boolean" },
  local: { type: "boolean" },
  "server-command": { type: "string" },
  http: { type: "string" },
  token: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

const HELP = `Usage:
  oc-pilot setup [options]

Install the oc-pilot MCP server into agent CLIs by writing their native
configuration files. Existing settings and other MCP servers are preserved.

Options:
  -C, --cwd <dir>            Project directory (default: current)
      --client <name>        claude, cursor, opencode, codex, gemini, vscode, windsurf
                             Repeatable. Default: claude, cursor, opencode, vscode
      --all                  Configure every supported client
      --global               Write user-level config instead of project config
      --print                Print configs without writing files
      --local                Use this installation (node + dist/mcp.js) instead of npx
      --server-command <cmd> Override the MCP command, e.g. oc-pilot-mcp
      --http <url>           Use a remote Streamable HTTP MCP endpoint
      --token <token>        Bearer token for --http (or OC_PILOT_MCP_TOKEN)
      --force                Back up and replace an invalid JSON config
      --json                 Machine-readable result
  -h, --help                 Show this help

Examples:
  npx -y oc-pilot setup
  npx -y oc-pilot setup --all --local
  npx -y oc-pilot setup --client claude --client cursor
  npx -y oc-pilot setup --http https://oc-pilot.example.com/mcp --token "$OC_PILOT_MCP_TOKEN"
`;

interface LocalEntry {
  command: string;
  args: string[];
}

interface RemoteEntry {
  url: string;
  headers?: Record<string, string>;
}

interface ClientPlan {
  id: ClientId;
  name: string;
  path: string;
  format: "json" | "toml";
  config?: JsonObject;
  toml?: string;
}

function strings(values: Record<string, unknown>, key: string): string[] {
  const value = values[key];
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") return [value];
  throw new PilotError(`--${key} expects a value`, { exitCode: 2 });
}

function readJson(path: string, force: boolean): JsonObject {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("root value is not an object");
    }
    return parsed as JsonObject;
  } catch (error) {
    if (!force) {
      throw new PilotError(`Cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`, {
        hint: "Fix the file or rerun with --force to back it up and replace it.",
        exitCode: 2,
      });
    }
    renameSync(path, `${path}.bak`);
    log.warn(`Invalid config backed up to ${path}.bak`);
    return {};
  }
}

function writeJson(path: string, value: JsonObject): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function setMcpServers(root: JsonObject, key: string, entry: JsonObject): void {
  const current = root[key];
  const servers = current && typeof current === "object" && !Array.isArray(current) ? (current as JsonObject) : {};
  servers["oc-pilot"] = entry;
  root[key] = servers;
}

function openCodePath(cwd: string): string {
  const direct = join(cwd, "opencode.json");
  if (existsSync(direct)) return direct;
  const nested = join(cwd, ".opencode", "opencode.json");
  if (existsSync(nested)) return nested;
  return direct;
}

function vscodeGlobalPath(): string {
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Code", "User", "mcp.json");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Code", "User", "mcp.json");
  }
  return join(homedir(), ".config", "Code", "User", "mcp.json");
}

function clientPath(id: ClientId, cwd: string, global: boolean): string {
  switch (id) {
    case "claude":
      return global ? join(homedir(), ".claude.json") : join(cwd, ".mcp.json");
    case "cursor":
      return global ? join(homedir(), ".cursor", "mcp.json") : join(cwd, ".cursor", "mcp.json");
    case "opencode":
      return global
        ? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode", "opencode.json")
        : openCodePath(cwd);
    case "codex":
      return join(homedir(), ".codex", "config.toml");
    case "gemini":
      return global ? join(homedir(), ".gemini", "settings.json") : join(cwd, ".gemini", "settings.json");
    case "vscode":
      return global ? vscodeGlobalPath() : join(cwd, ".vscode", "mcp.json");
    case "windsurf":
      return join(homedir(), ".codeium", "windsurf", "mcp_config.json");
  }
}

function localEntry(cwd: string, options: { local: boolean; serverCommand?: string }): LocalEntry {
  if (options.serverCommand) {
    return { command: options.serverCommand, args: ["--cwd", cwd] };
  }
  if (options.local) {
    const mcpPath = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp.js");
    return { command: process.execPath, args: [mcpPath, "--cwd", cwd] };
  }
  return { command: "npx", args: ["-y", `oc-pilot@${VERSION}`, "mcp", "--cwd", cwd] };
}

function remoteEntry(options: { http: string; token?: string }): RemoteEntry {
  return options.token
    ? { url: options.http, headers: { Authorization: `Bearer ${options.token}` } }
    : { url: options.http };
}

function localConfig(id: ClientId, entry: LocalEntry): JsonObject {
  if (id === "opencode") {
    return { type: "local", command: [entry.command, ...entry.args], enabled: true };
  }
  return { command: entry.command, args: entry.args };
}

function remoteConfig(id: ClientId, entry: RemoteEntry): JsonObject {
  if (id === "opencode") {
    return { type: "remote", url: entry.url, enabled: true, ...(entry.headers ? { headers: entry.headers } : {}) };
  }
  if (id === "claude" || id === "vscode") {
    return { type: "http", url: entry.url, ...(entry.headers ? { headers: entry.headers } : {}) };
  }
  return { url: entry.url, ...(entry.headers ? { headers: entry.headers } : {}) };
}

function applyJson(id: ClientId, root: JsonObject, entry: JsonObject): void {
  switch (id) {
    case "claude":
    case "cursor":
    case "gemini":
    case "windsurf":
      setMcpServers(root, "mcpServers", entry);
      return;
    case "vscode":
      setMcpServers(root, "servers", entry);
      return;
    case "opencode": {
      const current = root.mcp;
      const mcp = current && typeof current === "object" && !Array.isArray(current) ? (current as JsonObject) : {};
      setMcpServers(mcp, "servers", entry);
      root.mcp = mcp;
      return;
    }
    case "codex":
      throw new Error("Codex uses TOML");
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function codexBlock(entry: LocalEntry | RemoteEntry): string {
  if ("url" in entry) {
    return `[mcp_servers.oc_pilot]\nurl = ${tomlString(entry.url)}\nbearer_token_env_var = "OC_PILOT_MCP_TOKEN"\n`;
  }
  const args = entry.args.map(tomlString).join(", ");
  return `[mcp_servers.oc_pilot]\ncommand = ${tomlString(entry.command)}\nargs = [${args}]\n`;
}

function mergeToml(path: string, block: string, force: boolean): string {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const marker = "[mcp_servers.oc_pilot]";
  const start = existing.indexOf(marker);
  if (start === -1) {
    return `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${block}`;
  }
  const next = existing.indexOf("\n[", start + marker.length);
  if (next === -1) {
    return `${existing.slice(0, start)}${block}`;
  }
  if (force) {
    return `${existing.slice(0, start)}${block}${existing.slice(next + 1)}`;
  }
  return `${existing.slice(0, start)}${block}${existing.slice(next + 1)}`;
}

function planClient(
  id: ClientId,
  cwd: string,
  options: { global: boolean; local: boolean; serverCommand?: string; http?: string; token?: string; force: boolean },
): ClientPlan {
  const path = clientPath(id, cwd, options.global);
  if (id === "codex") {
    const block = options.http ? codexBlock(remoteEntry({ http: options.http, token: options.token })) : codexBlock(localEntry(cwd, options));
    return { id, name: CLIENT_NAMES[id], path, format: "toml", toml: block };
  }
  const root = readJson(path, options.force);
  const entry = options.http
    ? remoteConfig(id, remoteEntry({ http: options.http, token: options.token }))
    : localConfig(id, localEntry(cwd, options));
  applyJson(id, root, entry);
  return { id, name: CLIENT_NAMES[id], path, format: "json", config: root };
}

function printPlan(plan: ClientPlan): void {
  process.stdout.write(`\n# ${plan.name} -> ${plan.path}\n`);
  if (plan.format === "toml") {
    process.stdout.write(plan.toml ?? "");
  } else {
    process.stdout.write(`${JSON.stringify(plan.config, null, 2)}\n`);
  }
}

export async function runSetup(argv: string[]): Promise<number> {
  const { values } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const cwd = asString(values, "cwd") ? resolve(process.cwd(), asString(values, "cwd")!) : process.cwd();
  if (!existsSync(cwd)) throw new PilotError(`Directory not found: ${cwd}`, { exitCode: 2 });

  const requested = strings(values as Record<string, unknown>, "client");
  const ids = (asBoolean(values, "all")
    ? ALL_CLIENTS
    : requested.length > 0
      ? requested
      : DEFAULT_CLIENTS) as ClientId[];
  for (const id of ids) {
    if (!(id in CLIENT_NAMES)) {
      throw new PilotError(`Unknown client: ${id}`, {
        hint: `Use one of: ${ALL_CLIENTS.join(", ")}`,
        exitCode: 2,
      });
    }
  }

  const http = asString(values, "http");
  const token = asString(values, "token") ?? process.env.OC_PILOT_MCP_TOKEN;
  const options = {
    global: asBoolean(values, "global"),
    local: asBoolean(values, "local"),
    serverCommand: asString(values, "server-command"),
    http,
    token,
    force: asBoolean(values, "force"),
  };

  const plans: ClientPlan[] = [];
  for (const id of ids) plans.push(planClient(id, cwd, options));

  if (asBoolean(values, "print")) {
    if (asBoolean(values, "json")) {
      process.stdout.write(`${JSON.stringify({ cwd, clients: plans }, null, 2)}\n`);
    } else {
      for (const plan of plans) printPlan(plan);
    }
    return 0;
  }

  for (const plan of plans) {
    if (plan.format === "toml") {
      mkdirSync(dirname(plan.path), { recursive: true });
      writeFileSync(plan.path, mergeToml(plan.path, plan.toml ?? "", options.force), "utf8");
    } else {
      writeJson(plan.path, plan.config ?? {});
    }
  }

  if (asBoolean(values, "json")) {
    process.stdout.write(
      `${JSON.stringify(
        {
          cwd,
          transport: http ? "http" : "stdio",
          clients: plans.map((plan) => ({ id: plan.id, name: plan.name, path: plan.path })),
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  log.success(`oc-pilot MCP configured for ${plans.length} client(s).`);
  for (const plan of plans) log.detail(`${plan.name}: ${plan.path}`);
  if (http) {
    log.detail(`Remote endpoint: ${http}`);
  } else {
    log.detail("Restart the client or reload its MCP servers, then ask it to call review or scan.");
  }
  return 0;
}
