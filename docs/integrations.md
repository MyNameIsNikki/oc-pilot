# Embedding oc-pilot in agent CLIs

`oc-pilot` exposes every recipe through a local MCP server, so Claude Code,
Codex, Cursor, Gemini CLI, OpenCode, and custom agents can call the same
read-only analysis engine instead of re-implementing prompts in every client.

There are two integration levels:

1. **MCP (recommended)** — the agent calls structured tools. No prompt copying.
2. **CLI from a shell tool** — the agent runs `oc-pilot ... --json` and parses
   stdout. Works anywhere with a terminal tool.

The MCP server is local, stores no code, and sends data only to the model
provider configured in OpenCode.

## Requirements

- Node.js 22+
- OpenCode 2.x for the model-backed tools (`review`, `test_fix`, `docgen`,
  `custom`). `scan` is fully offline.
- The project to analyze is the server's working directory.

```sh
# Works now, before the first npm release:
npm install -g github:MyNameIsNikki/oc-pilot
oc-pilot --version
oc-pilot mcp --version
```

For local development:

```sh
npm install
npm run build
node dist/mcp.js --cwd /absolute/path/to/project
```

Use an **absolute** `--cwd`. MCP clients often start servers from `/` or from
their own install directory, not from your repository.

Most clients can be configured automatically:

```sh
oc-pilot setup --client claude --local
oc-pilot setup --client codex --global
oc-pilot setup --client cursor --local --print
```

`setup` preserves existing servers and unrelated settings. Use `--http` and
`--token` to point a client at a remote server instead of a local stdio process.

## MCP tools

| Tool | Purpose | Required arguments |
| --- | --- | --- |
| `review` | Review a git diff or supplied patch | none (git mode by default) |
| `test_fix` | Run tests or analyze a captured failure log | none (auto-detect command) |
| `fix` | Propose a patch; optionally apply and test it | none |
| `docgen` | Generate doc comments for files | `files: string[]` |
| `custom` | Free-form request with optional diff | `instruction: string` |
| `scan` | Offline secret scan, no model call | none (git mode by default) |

All tools return:

- `content[0].text` — pretty-printed JSON for the agent to read.
- `structuredContent` — the same JSON as structured data.
- `_meta.exitCode` — CLI exit code.
- `_meta.policyFailed` — `true` when exit code 3 came from
  `--fail-on` / `--fail-on-secrets`.

A policy failure is **not** an MCP tool error. The agent should read
`structuredContent.findings` and decide what to do.

### Argument conventions

- `diff` is the **unified diff text**, not a path.
- `test_fix.log` is the **test output text**, not a path.
- `paths` are repo-relative paths or path prefixes.
- `fail_on`: `none | critical | warning | style` (default from config).
- `lang`: `en | ru` (model-facing output language).
- `repo_context`: `true` gives the agent read-only `read`/`glob`/`grep`
  access inside the project; `false` uses full changed files as context.
- `no_secret_scan`: disables redaction. Do not use it with untrusted input.
- `fix.apply` defaults to `false`. With `true`, the server applies the patch,
  runs `command` (or auto-detects tests), and reverts on failure. `no_tests`
  skips the test run; `rounds` controls repair attempts (1–5).

Example call:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "review",
    "arguments": {
      "fail_on": "warning",
      "lang": "en"
    }
  }
}
```

## Streamable HTTP and Docker

Stdio is the simplest local setup. For a container, a shared host, or a remote
agent, expose the same tools over Streamable HTTP:

```sh
oc-pilot-mcp --http --host 127.0.0.1 --port 8787 --path /mcp \
  --cwd /workspace --token "$OC_PILOT_MCP_TOKEN"
```

- `POST /mcp` accepts JSON-RPC. The initialize response returns
  `Mcp-Session-Id`; send it on subsequent requests.
- `OPTIONS /mcp` handles CORS preflight.
- `GET /health` returns `{"status":"ok","name":"oc-pilot"}` without auth.
- When `--token` is set, all other requests need
  `Authorization: Bearer <token>`.
- Binding a non-loopback host without a token of at least 16 characters is
  refused.
- HTTP is read-only by default: `fix` with `apply: true` and `test_fix` that
  runs a new command are rejected. Add `--allow-write` only for a trusted
  deployment.

A minimal container:

```sh
export OC_PILOT_MCP_TOKEN="$(openssl rand -hex 24)"
docker build -t oc-pilot-mcp .
docker run --rm -p 8787:8787 \
  -e OC_PILOT_MCP_TOKEN="$OC_PILOT_MCP_TOKEN" \
  -e ANTHROPIC_API_KEY=... \
  -v "$PWD:/workspace" \
  oc-pilot-mcp
```

`docker-compose.yml` requires `OC_PILOT_MCP_TOKEN`, mounts the current
directory at `/workspace`, and exposes port 8787. Put TLS and rate limiting in
front of any public deployment. The server is single-tenant: the token grants
analysis and, only with `OC_PILOT_MCP_READ_ONLY=false`, write access to the
mounted workspace.

## Agent skills

`skills/oc-pilot/SKILL.md` is a portable Agent Skill. It tells an agent when to
call `scan`, `review`, `test_fix`, `fix`, and `docgen`, prefers MCP tools, and
documents safety rules for `fix.apply`. Install it by copying
`skills/oc-pilot` into the client's skills directory (for Claude Code, usually
`.claude/skills/oc-pilot`).

## Claude Code

### MCP

Project `.mcp.json`:

```json
{
  "mcpServers": {
    "oc-pilot": {
      "command": "oc-pilot-mcp",
      "args": ["--cwd", "/absolute/path/to/project"]
    }
  }
}
```

Or register it from the CLI:

```sh
claude mcp add oc-pilot -- oc-pilot-mcp --cwd /absolute/path/to/project
```

Claude Code will expose `review`, `test_fix`, `fix`, `docgen`, `custom`, and
`scan` as MCP tools. A typical instruction:

> Before proposing a fix, call the `oc-pilot` `review` tool with
> `fail_on: "warning"` and include its critical findings in your answer.

### Shell fallback

If MCP is unavailable, Claude Code can run the CLI through Bash:

```sh
git diff | oc-pilot review --stdin --json --fail-on critical
```

For read-only analysis, keep Bash enabled but tell Claude not to edit files
until it has read the JSON output.

## OpenAI Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.oc_pilot]
command = "oc-pilot-mcp"
args = ["--cwd", "/absolute/path/to/project"]
```

Then ask Codex to use the `oc_pilot` MCP server. Codex's default read-only
sandbox is a good match for the review flow.

Shell fallback:

```sh
git diff | oc-pilot review --stdin --json --fail-on critical
```

`oc-pilot` itself needs network access to the OpenCode provider; the Codex
sandbox setting only controls the Codex process.

## Cursor

Project `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "oc-pilot": {
      "command": "oc-pilot-mcp",
      "args": ["--cwd", "/absolute/path/to/project"]
    }
  }
}
```

Global config is `~/.cursor/mcp.json`. After reloading Cursor, the five tools
appear in the MCP tool list.

For a shell-only setup, use Cursor's terminal:

```sh
git diff | oc-pilot review --stdin --json --fail-on warning
```

## Gemini CLI

`~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "oc-pilot": {
      "command": "oc-pilot-mcp",
      "args": ["--cwd", "/absolute/path/to/project"]
    }
  }
}
```

Gemini CLI is available to paid/enterprise users; Google One/unpaid users were
migrated to Antigravity CLI in June 2026. The MCP configuration is the same
shape in clients that support local stdio servers.

Shell fallback:

```sh
git diff | oc-pilot review --stdin --json --fail-on critical
```

## OpenCode

The built-in `oc-pilot` agent already provides read-only repository context;
no MCP setup is needed for the CLI recipes.

To expose oc-pilot as an MCP server inside another OpenCode project, add a
local server to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "oc-pilot": {
        "type": "local",
        "command": ["oc-pilot-mcp", "--cwd", "/absolute/path/to/project"],
        "enabled": true
      }
    }
  }
}
```

Keep the permission policy read-only in the calling agent. `oc-pilot` does not
edit files, but the calling agent may have its own write tools.

## DeepSeek Harness

DeepSeek Harness (`dsh`, developer preview) loads MCP servers through the
`@deepseek-ai/dsh-mcp-client` plugin. One plugin instance represents one
server. Add it to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: mcp-oc-pilot
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: oc_pilot
        transport: stdio
        command: npx
        args: ['-y', 'oc-pilot@0.4.0', 'mcp', '--cwd', '/absolute/path/to/project']
        toolCallTimeoutMs: 300000
```

For a remote read-only server:

```yaml
- insert:
    - id: mcp-oc-pilot
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: oc_pilot
        transport: streamable-http
        url: https://oc-pilot.example.com/mcp
        headers:
          Authorization: !!js 'Bearer ' + process.env.OC_PILOT_MCP_TOKEN
```

Tools appear as `mcp__oc_pilot__review`, `mcp__oc_pilot__scan`,
`mcp__oc_pilot__fix`, and so on. `serverName` must match
`[A-Za-z0-9_-]{1,32}`. The config format is a preview and may change; check the
DeepSeek Harness release notes when upgrading.

## Any agent with a shell

This is the lowest-common-denominator integration and works in Aider, Continue,
Windsurf, custom LangGraph/CrewAI agents, and CI scripts.

System or developer instruction:

```text
For code review, run:
  git diff | oc-pilot review --stdin --json --fail-on critical
Parse stdout as JSON. Use the `analysis` field for the human explanation and
`findings` for structured severity/location data. Never invent findings that
are absent from the JSON.
```

Other commands:

```sh
git diff | oc-pilot scan --stdin --json
oc-pilot test-fix --json
oc-pilot docgen "src/**/*.ts" --json
oc-pilot custom "Find race conditions" --git-diff --json
```

All commands support `--output <file>` when the agent cannot read stdout.

## CI gate

```sh
git diff origin/main...HEAD | oc-pilot review --stdin --json --fail-on critical
```

Exit code 3 means the policy threshold was reached. Save stdout as an artifact
so the agent or reviewer can read the structured findings.

In GitHub Actions, `--github` prints inline annotations instead of JSON:

```sh
oc-pilot review --base origin/main --fail-on warning --github
```

A tested patch loop is also available, but it writes to the checkout:

```sh
oc-pilot fix --diff changes.diff --apply --command "npm test"
```

The patch is reverted when tests fail. Do not run it on a shared working tree.

## Troubleshooting

- **`oc-pilot-mcp: command not found`** — install globally or use the absolute
  path to `dist/mcp.js`; GUI clients often do not inherit your shell `PATH`.
- **Wrong repository** — `--cwd` is fixed when the server starts. Start one
  server per project.
- **No findings but a large diff** — the diff may have been truncated. Check
  `meta.diff.truncated` in JSON.
- **Windows paths** — use absolute paths with forward slashes
  (`C:/Users/me/project`) in JSON configs.
- **Russian UI messages** — the CLI UI is Russian; model output language is
  controlled by `--lang` / `lang` (default `en`). MCP results are JSON, so this
  does not affect agent parsing.
