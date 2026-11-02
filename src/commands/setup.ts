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
  npx: { type: "boolean" },
  "allow-write": { type: "boolean" },
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
      --local                Use this installation (node + dist/mcp.js)
      --npx                  Use npx -y oc-pilot@<version> mcp instead of a local path
      --allow-write          Allow the agent to apply patches and run tests
      --server-command <cmd> Override the MCP command, e.g. oc-pilot-mcp
      --http <url>           Use a remote Streamable HTTP MCP endpoint
      --token <value>        Enable bearer auth via OC_PILOT_MCP_TOKEN (value is not stored)
      --force                Back up and replace an invalid JSON config
      --json                 Machine-readable result
  -h, --help                 Show this help

Examples:
  npx -y oc-pilot setup
  npx -y oc-pilot setup --all --local
  npx -y oc-pilot setup --client claude --client cursor
  npx -y oc-pilot setup --client claude --local --allow-write
  npx -y oc-pilot setup --http https://oc-pilot.example.com/mcp --token "$OC_PILOT_MCP_TOKEN"
`;

interface LocalEntry {
  command: string;
  args: string[];
}

interface RemoteEntry {
  url: string;
  auth: boolean;
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

function npxEntry(cwd: string, allowWrite: boolean): LocalEntry {
  const write = allowWrite ? ["--allow-write"] : [];
  return { command: "npx", args: ["-y", `oc-pilot@${VERSION}`, "mcp", "--cwd", cwd, ...write] };
}

function localEntry(
  cwd: string,
  options: { local: boolean; npx?: boolean; serverCommand?: string; allowWrite?: boolean },
): LocalEntry {
  const write = options.allowWrite ? ["--allow-write"] : [];
  if (options.serverCommand) {
    return { command: options.serverCommand, args: ["--cwd", cwd, ...write] };
  }
  const self = fileURLToPath(import.meta.url);
  const fromNpxCache = /[\\/]_npx[\\/]/.test(self);
  if (!options.local && (options.npx || fromNpxCache)) {
    return npxEntry(cwd, Boolean(options.allowWrite));
  }
  const mcpPath = join(dirname(self), "..", "mcp.js");
  return { command: process.execPath, args: [mcpPath, "--cwd", cwd, ...write] };
}

function remoteEntry(options: { http: string; token?: string }): RemoteEntry {
  return { url: options.http, auth: Boolean(options.token) };
}

function localConfig(id: ClientId, entry: LocalEntry): JsonObject {
  if (id === "opencode") {
    return { type: "local", command: [entry.command, ...entry.args] };
  }
  return { command: entry.command, args: entry.args };
}

function remoteConfig(id: ClientId, entry: RemoteEntry): JsonObject {
  const headers = entry.auth
    ? {
        Authorization:
          id === "opencode" ? "Bearer {env:OC_PILOT_MCP_TOKEN}" : "Bearer ${OC_PILOT_MCP_TOKEN}",
      }
    : undefined;
  if (id === "opencode") {
    return { type: "remote", url: entry.url, ...(headers ? { headers } : {}) };
  }
  if (id === "claude" || id === "vscode") {
    return { type: "http", url: entry.url, ...(headers ? { headers } : {}) };
  }
  return { url: entry.url, ...(headers ? { headers } : {}) };
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
    const auth = entry.auth ? `\nbearer_token_env_var = "OC_PILOT_MCP_TOKEN"` : "";
    return `[mcp_servers.oc_pilot]\nurl = ${tomlString(entry.url)}${auth}\n`;
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
  options: {
    global: boolean;
    local: boolean;
    npx?: boolean;
    allowWrite?: boolean;
    serverCommand?: string;
    http?: string;
    token?: string;
    force: boolean;
  },
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
    npx: asBoolean(values, "npx"),
    allowWrite: asBoolean(values, "allow-write"),
    serverCommand: asString(values, "server-command"),
    http,
    token,
    force: asBoolean(values, "force"),
  };

  if (options.local && options.npx) {
    throw new PilotError("--local and --npx are mutually exclusive", { exitCode: 2 });
  }
  if (options.http && options.allowWrite) {
    throw new PilotError("--allow-write must be set on the remote MCP server, not in client config", {
      exitCode: 2,
    });
  }

  const plans: ClientPlan[] = [];
  for (const id of ids) plans.push(planClient(id, cwd, options));

  if (http && token) {
    log.info("The token is referenced as OC_PILOT_MCP_TOKEN; export it in the client environment.");
  }

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
