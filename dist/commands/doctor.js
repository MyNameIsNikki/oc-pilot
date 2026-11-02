import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { asBoolean } from "../core/parse.js";
import { DEFAULT_API_KEY_ENV, isLoopbackUrl, normalizeBaseUrl, } from "../core/engine.js";
import { detectTestCommand } from "../core/project.js";
import { parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { VERSION } from "../version.js";
const OPTIONS = withCommon({});
const HELP = `Usage:
  oc-pilot doctor [options]

Checks the local setup without calling a model: Node.js, git, the selected
engine, credentials, test discovery, and MCP client configuration.

Options:
  -C, --cwd <dir>       Project directory (default: current)
      --config <path>   Path to .oc-pilot.json
      --engine <name>   Check this engine: opencode or openai
      --base-url <url>  OpenAI-compatible base URL
      --api-key-env <n> Environment variable that stores the API key
  -m, --model <id>      Model to verify in the selected engine
      --strict          Exit 1 on warnings as well as errors
      --json            Machine-readable report
  -h, --help            Show this help

Examples:
  oc-pilot doctor
  oc-pilot doctor --engine openai --model deepseek-chat
  oc-pilot doctor --json
`;
function major(version) {
    return Number(version.replace(/^v/, "").split(".")[0]);
}
function findExecutable(name) {
    const path = process.env.PATH;
    if (!path)
        return undefined;
    const extensions = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
    for (const directory of path.split(process.platform === "win32" ? ";" : ":")) {
        if (!directory)
            continue;
        for (const extension of extensions) {
            const candidate = join(directory, `${name}${extension}`);
            if (existsSync(candidate))
                return candidate;
        }
    }
    return undefined;
}
function runVersion(command) {
    try {
        const result = spawnSync(command, ["--version"], {
            encoding: "utf8",
            timeout: 10_000,
            shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command),
            windowsHide: true,
        });
        if (result.status !== 0)
            return undefined;
        return (result.stdout || result.stderr).trim().split(/\r?\n/)[0]?.trim() || undefined;
    }
    catch {
        return undefined;
    }
}
function readJson(path) {
    try {
        const value = JSON.parse(readFileSync(path, "utf8"));
        return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
    }
    catch {
        return undefined;
    }
}
function objectAt(root, key) {
    const value = root?.[key];
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function mcpClients(cwd) {
    const clients = [];
    const home = homedir();
    const projectChecks = [
        ["Claude Code", join(cwd, ".mcp.json"), ["mcpServers"]],
        ["Cursor", join(cwd, ".cursor", "mcp.json"), ["mcpServers"]],
        ["Gemini CLI", join(cwd, ".gemini", "settings.json"), ["mcpServers"]],
        ["VS Code", join(cwd, ".vscode", "mcp.json"), ["servers"]],
        ["Generic .agents", join(cwd, ".agents", "mcp.json"), ["mcpServers"]],
    ];
    for (const [name, path, keys] of projectChecks) {
        const root = existsSync(path) ? readJson(path) : undefined;
        if (keys.some((key) => Boolean(objectAt(root, key)?.["oc-pilot"])))
            clients.push(name);
    }
    const openCodeProject = [join(cwd, "opencode.json"), join(cwd, ".opencode", "opencode.json")];
    for (const path of openCodeProject) {
        const root = existsSync(path) ? readJson(path) : undefined;
        if (objectAt(objectAt(root, "mcp"), "servers")?.["oc-pilot"]) {
            clients.push("OpenCode");
            break;
        }
    }
    const zcodeProject = join(cwd, ".zcode", "config.json");
    const zcodeRoot = existsSync(zcodeProject) ? readJson(zcodeProject) : undefined;
    if (objectAt(objectAt(zcodeRoot, "mcp"), "servers")?.["oc-pilot"])
        clients.push("ZCode");
    if (!clients.includes("ZCode")) {
        const zcodeGlobal = join(home, ".zcode", "cli", "config.json");
        const zcodeGlobalRoot = existsSync(zcodeGlobal) ? readJson(zcodeGlobal) : undefined;
        if (objectAt(objectAt(zcodeGlobalRoot, "mcp"), "servers")?.["oc-pilot"])
            clients.push("ZCode");
    }
    const globalChecks = [
        ["Claude Code", join(home, ".claude.json"), ["mcpServers"]],
        ["Gemini CLI", join(home, ".gemini", "settings.json"), ["mcpServers"]],
        ["Windsurf", join(home, ".codeium", "windsurf", "mcp_config.json"), ["mcpServers"]],
        ["Generic .agents", join(home, ".agents", "mcp.json"), ["mcpServers"]],
    ];
    for (const [name, path, keys] of globalChecks) {
        if (clients.includes(name))
            continue;
        const root = existsSync(path) ? readJson(path) : undefined;
        if (keys.some((key) => Boolean(objectAt(root, key)?.["oc-pilot"])))
            clients.push(name);
    }
    const codex = join(home, ".codex", "config.toml");
    if (existsSync(codex)) {
        try {
            if (/\[mcp_servers\.oc[_-]pilot\]/.test(readFileSync(codex, "utf8")))
                clients.push("Codex");
        }
        catch {
            // Ignore an unreadable config.
        }
    }
    return [...new Set(clients)];
}
function checkEngine(ctx) {
    const checks = [];
    const engine = ctx.config.engine;
    if (engine === "opencode") {
        const executable = findExecutable("opencode");
        if (!executable) {
            checks.push({
                id: "engine",
                status: "error",
                title: "OpenCode CLI not found",
                detail: "The default engine runs reviews through OpenCode.",
                fix: "npm install -g opencode-ai && opencode auth list",
            });
        }
        else {
            const version = runVersion(executable);
            checks.push({
                id: "engine",
                status: version ? "ok" : "warn",
                title: version ? `OpenCode ${version}` : "OpenCode found but --version failed",
                detail: executable,
                fix: version ? undefined : "Run `opencode --version` manually and check the installation.",
            });
        }
        if (!ctx.config.model) {
            checks.push({
                id: "model",
                status: "info",
                title: "No explicit model",
                detail: "OpenCode will use its configured default model. Set --model or model in .oc-pilot.json for reproducibility.",
            });
        }
        else {
            checks.push({ id: "model", status: "ok", title: `Model: ${ctx.config.model}` });
        }
        return checks;
    }
    const baseUrl = normalizeBaseUrl(ctx.config.baseUrl);
    if (!ctx.config.model) {
        checks.push({
            id: "model",
            status: "error",
            title: "No model for engine=openai",
            detail: "The OpenAI-compatible engine needs a concrete model name.",
            fix: "oc-pilot doctor --model deepseek-chat, or set model in .oc-pilot.json",
        });
    }
    else {
        checks.push({ id: "model", status: "ok", title: `Model: ${ctx.config.model}` });
    }
    const envName = ctx.config.apiKeyEnv?.trim() || DEFAULT_API_KEY_ENV;
    let key = process.env[envName]?.trim();
    if (!key && envName === DEFAULT_API_KEY_ENV)
        key = process.env.OPENAI_API_KEY?.trim();
    if (!key && !isLoopbackUrl(baseUrl)) {
        checks.push({
            id: "credentials",
            status: "error",
            title: `API key is not set (${envName})`,
            detail: "Remote OpenAI-compatible endpoints require a bearer token.",
            fix: `export ${envName}=...  (PowerShell: $env:${envName}="...")`,
        });
    }
    else {
        checks.push({
            id: "credentials",
            status: "ok",
            title: key ? `API key is set (${envName})` : "Local endpoint without an API key",
            detail: baseUrl,
        });
    }
    if (baseUrl.startsWith("http://") && !isLoopbackUrl(baseUrl)) {
        checks.push({
            id: "transport",
            status: "warn",
            title: "Plain HTTP endpoint",
            detail: "The API key and source code travel unencrypted. Use HTTPS or a trusted tunnel.",
        });
    }
    else {
        checks.push({ id: "transport", status: "ok", title: `Endpoint: ${baseUrl}` });
    }
    return checks;
}
function checkGit(cwd) {
    const version = runVersion("git");
    if (!version) {
        return [
            {
                id: "git",
                status: "error",
                title: "git not found",
                detail: "Diff collection and fix/test workflows need git.",
                fix: "Install git and reopen the terminal.",
            },
        ];
    }
    const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd,
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
    });
    return [
        { id: "git", status: "ok", title: version },
        {
            id: "repository",
            status: inside.status === 0 && inside.stdout.trim() === "true" ? "ok" : "warn",
            title: inside.stdout.trim() === "true" ? "Inside a git repository" : "Not a git repository",
            detail: "review and fix can still work with --diff, but normal diff collection needs git.",
            fix: inside.stdout.trim() === "true" ? undefined : "git init",
        },
    ];
}
export async function runDoctor(argv) {
    const { values } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(HELP);
        return 0;
    }
    const ctx = resolveContext(values);
    const checks = [];
    const nodeMajor = major(process.versions.node);
    checks.push({
        id: "node",
        status: nodeMajor >= 22 ? "ok" : "error",
        title: `Node.js v${process.versions.node}`,
        detail: nodeMajor >= 22 ? undefined : "Node.js 22 or newer is required.",
        fix: nodeMajor >= 22 ? undefined : "Install Node.js 22+ from https://nodejs.org",
    });
    checks.push({
        id: "config",
        status: "ok",
        title: ctx.configPath ? `Config: ${ctx.configPath}` : "Config: built-in defaults",
        detail: ctx.configPath ? undefined : "Run `oc-pilot init` to create .oc-pilot.json.",
    });
    checks.push(...checkEngine(ctx));
    checks.push(...checkGit(ctx.cwd));
    const detected = detectTestCommand(ctx.cwd);
    checks.push({
        id: "tests",
        status: detected ? "ok" : "info",
        title: detected ? `Test command: ${detected.command}` : "Test command not detected",
        detail: detected ? detected.source : "test-fix and fix --apply may need --command.",
    });
    const clients = mcpClients(ctx.cwd);
    checks.push({
        id: "mcp",
        status: clients.length > 0 ? "ok" : "warn",
        title: clients.length > 0 ? `MCP configured: ${clients.join(", ")}` : "MCP is not configured for a detected client",
        detail: clients.length > 0 ? undefined : "Optional, but this is how other agents call oc-pilot.",
        fix: clients.length > 0 ? undefined : "oc-pilot setup --all",
    });
    const rules = join(ctx.cwd, ".oc-pilot", "rules.md");
    checks.push({
        id: "rules",
        status: existsSync(rules) ? "ok" : "info",
        title: existsSync(rules) ? "Project rules found" : "No project rules (optional)",
        detail: existsSync(rules) ? rules : "Add .oc-pilot/rules.md to teach the reviewer your conventions.",
    });
    const summary = {
        ok: checks.filter((check) => check.status === "ok").length,
        warn: checks.filter((check) => check.status === "warn").length,
        error: checks.filter((check) => check.status === "error").length,
        info: checks.filter((check) => check.status === "info").length,
    };
    const report = {
        version: VERSION,
        cwd: ctx.cwd,
        configPath: ctx.configPath ?? null,
        engine: ctx.config.engine,
        checks,
        summary,
    };
    if (ctx.flags.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }
    else {
        process.stdout.write(`oc-pilot doctor ${VERSION}\n\n`);
        for (const check of checks) {
            const icon = check.status === "ok" ? "✅" : check.status === "warn" ? "⚠️" : check.status === "error" ? "❌" : "ℹ️";
            process.stdout.write(`${icon} ${check.title}\n`);
            if (check.detail)
                process.stdout.write(`   ${check.detail}\n`);
            if (check.fix)
                process.stdout.write(`   fix: ${check.fix}\n`);
        }
        process.stdout.write(`\nSummary: ${summary.ok} ok, ${summary.warn} warning(s), ${summary.error} error(s), ${summary.info} note(s).\n`);
    }
    if (summary.error > 0)
        return 1;
    if (ctx.flags.strict && summary.warn > 0)
        return 1;
    return 0;
}
//# sourceMappingURL=doctor.js.map