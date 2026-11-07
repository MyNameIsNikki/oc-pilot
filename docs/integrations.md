# Embedding oc-pilot in agent CLIs

`oc-pilot` exposes every recipe through a local MCP server, so Claude Code,
Codex, Cursor, Gemini CLI, OpenCode, and custom agents can call the same
read-only analysis engine instead of re-implementing prompts in every client.

There are two integration levels:

1. **MCP (recommended)** — the agent calls structured tools. No prompt copying.
2. **CLI from a shell tool** — the agent runs `oc-pilot ... --json` and parses
   stdout. Works anywhere with a terminal tool.

The MCP server is local, stores no code, and sends data only to the model
provider configured for the selected engine.

## Requirements

- Node.js 22+
- One model engine: OpenCode 2.x, or any OpenAI-compatible API endpoint and key.
  `scan` is fully offline.
- The project to analyze is the server's working directory.

```sh
# Works now, before the first npm release (pin the tag):
npm install -g https://github.com/MyNameIsNikki/oc-pilot/archive/refs/tags/v0.5.2.tar.gz
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

Most clients can be configured automatically. With no `--client`, `setup`
detects installed clients from commands and config directories:

```sh
oc-pilot setup
oc-pilot setup --client claude --local
oc-pilot setup --client codex --global
oc-pilot setup --client cursor --local --print
```

### Engine and credentials

The default `opencode` engine gives the agent read-only `read`/`glob`/`grep`
tools. The `openai` engine needs no OpenCode installation: it calls
`/chat/completions` and automatically includes the full changed files.

```sh
# OpenCode
oc-pilot review

# OpenAI-compatible API
export OC_PILOT_API_KEY="..."
oc-pilot review --engine openai --model deepseek-chat \
  --base-url https://api.deepseek.com/v1

# Local Ollama, no key required for loopback
oc-pilot review --engine openai --model qwen2.5-coder \
  --base-url http://127.0.0.1:11434/v1
```

For an MCP client, export the key in the environment that launches the client,
or set `engine`, `baseUrl`, and `apiKeyEnv` in `.oc-pilot.json`. Run
`oc-pilot doctor` to verify the whole chain.

The key is read from `OC_PILOT_API_KEY` or `OPENAI_API_KEY`; configure another
variable with `--api-key-env`. Values are never printed in logs or errors.

With `--engine openai`, a diff larger than one prompt (300 000 characters) is
split into per-file slices; each slice gets its own API call and the responses
are merged into a single analysis (`meta.slices` shows the call count). No
files are dropped by truncation. `fix` always uses a single prompt because it
must return one patch.

`setup` preserves existing servers and unrelated settings. Use `--http` and
`--token` to point a client at a remote server instead of a local stdio process.
The token itself is never written to the config: the generated entry references
`OC_PILOT_MCP_TOKEN`, which must be exported in the client's environment.

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

## MCP resources

The server also exposes read-only context through MCP resources and resource
templates, so hosts can pull project context without invoking a model:

| Resource | Contents |
| --- | --- |
| `oc-pilot://config` | Resolved configuration and config path, JSON |
| `oc-pilot://rules` | `.oc-pilot/rules.md` with secrets redacted, or a notice |
| `oc-pilot://version` | Version and MCP protocol version, JSON |
| `oc-pilot://prompt/en`, `oc-pilot://prompt/ru` | The built-in system prompts |
| `oc-pilot://diff/{mode}` | Git diff by `staged`, `unstaged` or `head`, secrets redacted |
| `oc-pilot://scan/{mode}` | Offline secret scan findings (masked previews), JSON |
| `oc-pilot://file/{+path}` | Any project file up to 2 MB with secrets redacted |

Resources are listed with `resources/list` and `resources/templates/list` and
read with `resources/read`. File paths must stay inside the project directory;
binary files are rejected; detected secrets are always masked before the text
reaches the host model.

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
- MCP is read-only by default over both stdio and HTTP: `fix` with
  `apply: true` and `test_fix` that runs a new command are rejected. Add
  `--allow-write` only for a trusted client or deployment; `oc-pilot setup
  --allow-write` writes that flag into generated client config.

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
call `scan`, `review`, `invariants`, `test_fix`, `fix`, `test_gen`, `docgen`, `slop`, `mutate`, `fuzz`, `flaky`, `impact`, `deps`, `coverage`, `reviewers`, `test_guard`, `env_sync`, `mock_leak`, `ecosystem_verify`, `pack`, `pack_hologram`, `zoom_symbol`, `contract_drift`, `anti_regression`, `boundaries`, `test_plan`, `compliance_verify`, `brag`, `battle`, `cleanup`, `arch_diff`, `roast`, `cinema`, `bounty`, `autopsy`, `echo`, `sast`, `authz`, `preflight`, `ready`, and `receipt_verify`, prefers MCP tools, and
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

Claude Code will expose `review`, `invariants`, `test_fix`, `fix`, `test_gen`, `docgen`, `custom`,
`scan`, `slop`, `mutate`, `fuzz`, `flaky`, `impact`, `deps`, `coverage`, `reviewers`, `test_guard`, `env_sync`, `mock_leak`, `ecosystem_verify`, `pack`, `pack_hologram`, `zoom_symbol`, `contract_drift`, `anti_regression`, `boundaries`, `test_plan`, `compliance_verify`, `brag`, `battle`, `cleanup`, `arch_diff`, `roast`, `cinema`, `bounty`, `autopsy`, `echo`, `sast`, `authz`, `preflight`, `ready`, and `receipt_verify` as MCP tools. A typical instruction:

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
        "command": ["oc-pilot-mcp", "--cwd", "/absolute/path/to/project"]
      }
    }
  }
}
```

Keep the permission policy read-only in the calling agent. `oc-pilot` does not
edit files, but the calling agent may have its own write tools.

## ZCode (Z.ai)

ZCode reads MCP servers from project `.zcode/config.json` or user
`~/.zcode/cli/config.json`, under `mcp.servers`:

```json
{
  "mcp": {
    "servers": {
      "oc-pilot": {
        "command": "oc-pilot-mcp",
        "args": ["--cwd", "/absolute/path/to/project"]
      }
    }
  }
}
```

```sh
oc-pilot setup --client zcode --local
```

ZCode can also import existing Claude Code, Codex, OpenCode, or `.agents` MCP
servers from its Settings → MCP Servers → Import dialog, so one
`oc-pilot setup` for those clients is enough.

## Generic `.agents` clients

The `.agents` convention uses `mcpServers` in `~/.agents/mcp.json` or
`<project>/.agents/mcp.json`. ZCode reads it as a fallback, and other MCP-aware
tools can share the same file:

```sh
oc-pilot setup --client agents --local
```

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
        args: ['-y', 'oc-pilot@0.5.2', 'mcp', '--cwd', '/absolute/path/to/project']
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

Add `'--allow-write'` to `args` only for a trusted local harness that should apply patches and run tests. Tools appear as `mcp__oc_pilot__review`, `mcp__oc_pilot__scan`,
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

For GitHub Code Scanning, produce a SARIF 2.1.0 report and upload it:

```yaml
- run: oc-pilot scan --base origin/${{ github.base_ref }} --format sarif -o oc-pilot.sarif
- uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: oc-pilot.sarif
```

`--format sarif` is supported by `scan` and `review`. Rules are stable ids:
`oc-pilot/secret` (secrets, error), `oc-pilot/critical` (error),
`oc-pilot/warning` (warning; style findings are `note`). Secret previews stay
redacted in the report.

The repository also ships a composite action, so the whole gate is:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- uses: MyNameIsNikki/oc-pilot@v0.83.0
  with:
    command: scan
    args: --base origin/${{ github.base_ref }} --fail-on-secrets
```

A tested patch loop is also available, but it writes to the checkout:

```sh
oc-pilot fix --diff changes.diff --apply --command "npm test"
```

Before applying, `fix` saves a snapshot of tracked changes (binary patch) and
untracked files under `.git/oc-pilot/snapshots/`. The patch is still reverted
when tests fail. Restore a snapshot with `oc-pilot restore` (or
`oc-pilot restore --list` to pick one). Snapshots never enter commits;
`--no-snapshot` skips the safety copy.

## Git hooks

`oc-pilot install-hook` installs native POSIX sh hooks without husky:

```sh
oc-pilot install-hook              # pre-commit: oc-pilot preflight --staged
oc-pilot install-hook --scan       # lighter pre-commit: oc-pilot scan --staged
oc-pilot install-hook --pre-push   # also pre-push: oc-pilot review --fail-on critical
oc-pilot install-hook --uninstall  # remove managed hooks, restore backups
```

A foreign hook file is never overwritten silently: without `--force` the
install fails, with `--force` the old file is kept as `<hook>.oc-pilot.bak`.
`OC_PILOT_SKIP=1` bypasses the hooks for a single command. `core.hooksPath`
and worktrees are respected. `oc-pilot doctor --fix` refreshes outdated
managed hooks (keeping a backup) and prunes expired cache entries; foreign
hooks are never touched.

## pre-commit framework

The repository ships `.pre-commit-hooks.yaml`, so the standard
[pre-commit](https://pre-commit.com) framework works without local setup:

```yaml
repos:
  - repo: https://github.com/MyNameIsNikki/oc-pilot
    rev: v0.83.0
    hooks:
      - id: oc-pilot-secrets  # oc-pilot scan --staged
      - id: oc-pilot-review   # oc-pilot review --staged --fail-on critical --fail-on-secrets
```

Both hooks use `language: system` and expect `oc-pilot` on the `PATH`
(`npm i -g oc-pilot`). After changing the pinned `rev`, run
`pre-commit install-hooks` once.

## Secret ignore rules

False positives can be silenced per path or per line. `.oc-pilot/ignore`
holds one glob per line (`#` starts a comment); the inline marker
`oc-pilot:ignore-secret` silences a single source line:

```
# .oc-pilot/ignore
fixtures/**
docs/examples/**

const TOKEN = "sk-proj-..."; // oc-pilot:ignore-secret
```

The rules apply to every scanning point: diffs, project rules, docgen, and
full-file context. High-entropy assignments (20+ chars, Shannon entropy over
4 bits) are reported as critical `High-entropy secret`.

## Baseline and PR comments

Known findings can be grandfathered so `review` fails only on what is new:

```sh
oc-pilot review --staged --update-baseline   # write .oc-pilot/baseline.json, exit 0
oc-pilot review --staged --baseline --fail-on critical
```

A fingerprint is `severity | file | normalized text` — the line number is
deliberately excluded, so a finding survives code shifts above it. Baseline
filtering applies to the exit code, text output, `--json`, SARIF, and PR
comments; hidden findings are counted in `meta.baseline` (`known`, `total`).

`review --pr` posts the review to the current pull request. Inside GitHub
Actions it posts through the review API with `GITHUB_TOKEN` — the workflow needs
`permissions: pull-requests: write` and the default `GITHUB_TOKEN` secret; no
`gh` install or extra credentials are required. Up to 25 findings become inline
comments on the diff line they point at; findings that do not map to a changed
line (or whole runs outside Actions) fall back to a single summary comment,
which locally goes through the GitHub CLI (`gh pr comment --body-file -`) and
must be installed and authenticated. `--no-pr-inline` forces the summary
comment. `--pr-status` additionally posts a commit status under the `oc-pilot`
context: `failure` while critical findings remain, `success` otherwise, so a
branch protection rule can require it (needs `statuses: write`). On failure the
command exits 1 with a hint.

## Response cache

With `engine: openai`, identical requests are served from a local cache under
`.git/oc-pilot/cache/` — re-running review on the same diff costs zero tokens.
The key is `sha256(model + base URL + system prompt + input)`; entries live
for 24 hours by default (`cacheTtlSeconds`, env `OC_PILOT_CACHE_TTL`, `0`
disables caching). Triage, main, and slice calls all use the cache; the
opencode engine is never cached. Cache hits are reported in `meta.cache`
(`hit` | `miss`), and `--no-cache` bypasses the cache for a single run.

```sh
oc-pilot cache              # stats: entries, size, expired
oc-pilot cache --prune      # drop expired entries
oc-pilot cache --clear      # drop everything
```

`oc-pilot doctor` reports cache health and `oc-pilot doctor --fix` prunes
expired entries.

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
