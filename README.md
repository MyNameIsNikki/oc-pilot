# oc-pilot

Local AI code review, failing-test analysis, documentation generation, and secret scanning for agent CLIs.

`oc-pilot` is a small CLI and MCP server for developers who write code with AI agents. It reviews an uncommitted diff, follows the project beyond the changed lines, catches leaked credentials before they reach a model, explains a failing test, and returns findings as human-readable Markdown or machine-readable JSON.

It works with OpenCode out of the box, and with any MCP-capable agent: Claude Code, OpenAI Codex CLI, Cursor CLI, Gemini CLI, and others.

[Русская документация](README.ru.md)

## Why

Agents are good at producing code and bad at reviewing their own work. A normal chat turn does not:

- inspect the surrounding files and call sites;
- distinguish an introduced bug from pre-existing code;
- stop secrets from being sent to a third-party model;
- fail CI when a critical finding appears;
- return a stable schema that another agent can consume.

`oc-pilot` adds that layer without a PR bot, a hosted dashboard, or a vendor account.

## Requirements

- Node.js 22 or newer.
- OpenCode 2.x for the built-in OpenCode workflow.
- Any MCP client for the server workflow.

## Install

```bash
npm install -g oc-pilot
```

From source:

```bash
git clone https://github.com/MyNameIsNikki/oc-pilot.git
cd oc-pilot
npm install
npm run build
npm install -g .
```

Verify:

```bash
oc-pilot --version
oc-pilot-mcp --version
oc-pilot mcp --version
```

For development, run `node dist/cli.js` and `node dist/mcp.js` directly.

## Quick start (OpenCode)

```bash
cd /path/to/project

# Configure your agent in one command (Claude Code, Codex, Cursor, Gemini, OpenCode)
oc-pilot setup --client claude --local

# Fast offline gate, then model-backed review
oc-pilot scan
oc-pilot review --staged --fail-on-secrets
oc-pilot review --base main --fail-on warning --json

# Explain a failing test and propose a tested patch
oc-pilot test-fix
oc-pilot fix --apply --command "npm test"

# Generate docs
oc-pilot docgen "src/**/*.ts"
```

The default model prompt is English. Use `--lang ru` for Russian findings and docs, or set `lang` in config.

## How it works

1. `oc-pilot` collects the diff and project metadata.
2. It scans added lines for secrets and replaces detected values with `[REDACTED:<kind>]`.
3. It loads project rules from `.oc-pilot/rules.md` (optional).
4. It builds an input with `PROJECT_TYPE`, `RECIPE`, repository context, rules, the secret report, and `GIT_DIFF`.
5. A read-only OpenCode agent can use `read`, `glob`, and `grep` to inspect call sites and contracts. `edit`, `shell`, web access, and external directories are denied.
6. The model returns a fixed Markdown schema. `oc-pilot` parses severity and emits JSON on request.
7. `--fail-on` and `--fail-on-secrets` turn findings into CI exit codes.

With `--no-repo-context`, the agent gets no tools. `oc-pilot` instead includes full changed files (`FULL_FILE_CONTEXT`) within the context budget.

## Commands

### `review`

Reviews a git diff. By default it reviews all uncommitted changes (`git diff HEAD`).

```bash
oc-pilot review
oc-pilot review --staged
oc-pilot review --base main
oc-pilot review --include-untracked
oc-pilot review src/wallet.go --context "Balance must never be negative"
git diff | oc-pilot review --stdin
```

| Option | Purpose |
| --- | --- |
| `--staged` / `--unstaged` | Limit the diff to one side |
| `--base <ref>` | Review `<ref>...HEAD` |
| `--diff <file\|->` | Read a prepared unified diff |
| `--stdin` | Read the diff from stdin |
| `--include-untracked` | Add new files to the diff |
| `--context <text\|@file>` | Extra context for the model |
| `--no-secret-scan` | Disable secret scanning and redaction |
| `--fail-on-secrets` | Exit 3 on critical secrets |

### `test-fix`

Runs the detected test command, or reads a log, then explains the root cause and proposes a minimal fix.

```bash
oc-pilot test-fix
oc-pilot test-fix --command "go test ./..."
oc-pilot test-fix --log failures.log
npm test 2> failures.log; oc-pilot test-fix --log failures.log
```

A passing test run is skipped unless `--force` is used.

### `fix`

Asks the model for a unified diff, checks that it applies, and optionally applies it in the project. This is the only command that can modify your working tree, and only with `--apply`.

```bash
# Show the proposed patch and do not touch files
oc-pilot fix --diff changes.diff

# Apply, run tests, and keep the patch only when tests pass
oc-pilot fix --apply --command "npm test"

# Apply but keep the patch even when tests fail
oc-pilot fix --apply --command "go test ./..." --keep-on-test-failure

# Emit GitHub Actions annotations for the findings
oc-pilot review --github
```

| Option | Purpose |
| --- | --- |
| `--apply` | Apply the patch to the working tree |
| `--command <cmd>` | Test command after applying; defaults to `testCommand` or auto-detection |
| `--no-tests` | Apply without running tests |
| `--keep-on-test-failure` | Do not revert a patch when tests fail |

`fix` never commits or pushes. The patch is reverted when tests fail unless `--keep-on-test-failure` is used. Unrelated working-tree changes are not reverted.

### `docgen`

Generates GoDoc, RustDoc, JSDoc, Python docstrings, and similar comments without changing the code.

```bash
oc-pilot docgen src/core/prompt.ts
oc-pilot docgen "src/**/*.ts" --symbol buildPrompt
```

### `custom`

Runs a free-form analysis with an optional diff and context.

```bash
oc-pilot custom "Find data races" --git-diff
oc-pilot custom "Explain this module" --context @ARCHITECTURE.md
```

### `scan`

Offline secret scan. No model call.

```bash
oc-pilot scan
oc-pilot scan --staged --json
git diff main...HEAD | oc-pilot scan --stdin
```

Exit 1 means critical secrets were found. `--strict` also fails on warnings.

### `setup`

Configures an MCP client to launch `oc-pilot-mcp`. Existing server entries and unrelated settings are preserved. It writes configs for Claude Code, Codex, Cursor, Gemini CLI, OpenCode, VS Code, and Windsurf. By default it points at the current installation; `--npx` writes a version-pinned `npx -y oc-pilot@<version> mcp` entry instead.

```bash
# Project-local Claude Code config (.mcp.json)
oc-pilot setup --client claude --local

# OpenCode and Cursor in one run
oc-pilot setup --client opencode --client cursor --local

# Global config, or print without writing
oc-pilot setup --client codex --global
oc-pilot setup --client claude --local --print

# Remote HTTP server with a bearer token
oc-pilot setup --client claude --local \
  --http https://oc-pilot.example.com/mcp --token "$OC_PILOT_TOKEN"
```

| Option | Purpose |
| --- | --- |
| `--client <name>` | `claude`, `codex`, `cursor`, `gemini`, `opencode`, `vscode`, `windsurf`; repeatable |
| `--all` | Configure every supported client |
| `--global` | Write user-level config (project is the default) |
| `--local` | Force the current installation path |
| `--npx` | Force a version-pinned `npx` command |
| `--print` | Print the config instead of writing it |
| `--json` | JSON plan for automation |
| `--http <url>` | Configure a remote Streamable HTTP endpoint |
| `--token <token>` | Bearer token for the remote endpoint |
| `--cwd <dir>` | Project directory stored in the server args |
| `--force` | Replace an existing `oc-pilot` entry |

`setup` writes only MCP client config. It does not install packages or change your source.

### `init`

```bash
oc-pilot init
```

Creates `.oc-pilot.json`. It does not overwrite an existing config unless `--force` is passed.

## Common options

| Option | Default | Purpose |
| --- | --- | --- |
| `-C, --cwd <dir>` | current directory | Project directory |
| `-m, --model <id>` | OpenCode default | Model in `provider/model` form |
| `--agent <name>` | `oc-pilot` | Use another OpenCode agent |
| `--lang <en\|ru>` | `en` | Model-facing prompt and output language |
| `--no-repo-context` | off | Diff-only mode; no repository tools |
| `--rules <path>` | `.oc-pilot/rules.md` | Project rules file |
| `--fail-on <level>` | `none` | Exit 3 on `critical`, `warning`, or `style` findings |
| `--max-diff <size>` | `120000` | Diff/context budget |
| `--max-file <size>` | `60000` | Per-file budget for docgen |
| `--timeout <duration>` | `300` | Model/test timeout; supports `5m` |
| `-o, --output <path>` | stdout | Write the result to a file |
| `--json` | off | Machine-readable output |
| `--dry-run` | off | Print the prompt without calling a model |
| `--strict` | off | Exit 3 when the output schema is invalid |
| `--verbose` | off | Stream OpenCode diagnostics |

## Project rules

Add a `.oc-pilot/rules.md` at the project root, or point to one with `--rules` / the `rules` config field:

```markdown
- Keep handlers thin; business logic belongs in services.
- Errors must wrap the original cause.
- Never log request bodies or tokens.
- Prefer table-driven tests.
```

Rules are added to every recipe. They are scanned and redacted like any other project content, unless `--no-secret-scan` is used.

## Secret scanning

The scanner looks at added diff lines and common source-file patterns:

- private key blocks;
- OpenAI, Anthropic, Hugging Face, Groq, Google, GitHub, GitLab, npm, PyPI, Slack, Discord, Telegram, Stripe, SendGrid, DigitalOcean, and AWS keys;
- Azure storage account keys;
- JWTs, credentials in URLs, and sensitive `.env` assignments.

Detected values never appear in full in logs or JSON. The model receives `[REDACTED:<kind>]` and a masked preview. Review the provider's data policy before sending proprietary code.

`--no-secret-scan` and `redactSecrets: false` disable this protection for the diff, rules, and `FULL_FILE_CONTEXT`. Use them deliberately.

## Output and exit codes

Markdown response:

```markdown
### Analysis: Short conclusion.

#### Findings / Actions
- **🔴 Critical `wallet.go:10`**: nil pointer dereference.

#### Solution
```go
// minimal fix
```
```

`--lang ru` uses the Russian schema (`### Анализ:`, `#### Замечания / Действия`, `#### Решение`).

`--json` returns:

```json
{
  "recipe": "review",
  "projectType": "Go",
  "analysis": "### Analysis: ...",
  "findings": [
    { "severity": "critical", "location": "wallet.go:10", "text": "nil pointer dereference" }
  ],
  "secrets": [],
  "meta": {
    "agent": "oc-pilot",
    "model": "openai/gpt-5.5",
    "lang": "en",
    "repoContext": true,
    "formatValid": true,
    "formatWarnings": [],
    "findings": { "critical": 1, "warning": 0, "style": 0 }
  }
}
```

| Code | Meaning |
| --- | --- |
| 0 | Success, no failing policy |
| 1 | Runtime error, or critical secret from `scan` |
| 2 | Argument/configuration error |
| 3 | Policy gate: `--fail-on`, `--fail-on-secrets`, or `--strict` |

## Configuration

`oc-pilot` reads `.oc-pilot.json` from the project directory or an ancestor, then environment variables, then CLI flags.

```json
{
  "model": "anthropic/claude-sonnet-4-5",
  "agent": "oc-pilot",
  "lang": "en",
  "repoContext": true,
  "failOn": "none",
  "maxDiffChars": 120000,
  "maxOutputChars": 40000,
  "maxFileChars": 60000,
  "timeoutSeconds": 300,
  "redactSecrets": true,
  "testCommand": "npm test"
}
```

Environment variables: `OC_PILOT_MODEL`, `OC_PILOT_AGENT`, `OC_PILOT_LANG`, `OC_PILOT_REPO_CONTEXT`, `OC_PILOT_FAIL_ON`, `OC_PILOT_RULES`, `OC_PILOT_MAX_DIFF_CHARS`, `OC_PILOT_MAX_OUTPUT_CHARS`, `OC_PILOT_MAX_FILE_CHARS`, `OC_PILOT_TIMEOUT_SECONDS`, `OC_PILOT_TEST_COMMAND`, `OC_PILOT_REDACT_SECRETS`.

## MCP server

`oc-pilot-mcp` exposes the same recipes as MCP tools over stdio. This is the recommended way to embed oc-pilot in an agent: the agent calls a tool, and no prompt needs to be copied.

Tools: `review`, `test_fix`, `fix`, `docgen`, `custom`, `scan`.

Configure a client automatically:

```bash
oc-pilot setup --client claude --local
oc-pilot setup --client cursor --global
```

Start the server manually with an explicit project directory:

```bash
oc-pilot-mcp --cwd /absolute/path/to/project
# equivalent without a global install, pinned for reproducibility:
npx -y oc-pilot@0.4.0 mcp --cwd /absolute/path/to/project
```

The `diff` and `log` tool arguments are text, not file paths. `paths` and `files` are project-relative and cannot escape the project directory. `context` is literal text, not an `@file` reference. `base` must be a git ref. `lang`, `fail_on`, `repo_context`, and `no_secret_scan` are available where the corresponding CLI command supports them.

The MCP server does not add its own file access: it runs the same CLI with `--cwd` fixed at startup. A client cannot point it at another directory through a tool argument.

### Claude Code

```bash
claude mcp add oc-pilot -- oc-pilot-mcp --cwd /absolute/path/to/project
```

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

### OpenAI Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.oc_pilot]
command = "oc-pilot-mcp"
args = ["--cwd", "/absolute/path/to/project"]
```

### Cursor

`.cursor/mcp.json`:

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

### Gemini CLI

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

### OpenCode

`opencode.json`:

```json
{
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

### DeepSeek Harness

DeepSeek Harness (`dsh`) mounts MCP servers through `@deepseek-ai/dsh-mcp-client` in `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: mcp-oc-pilot
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: oc_pilot
        transport: stdio
        command: oc-pilot-mcp
        args: ['--cwd', '/absolute/path/to/project']
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

DeepSeek Harness labels the tools as `mcp__oc_pilot__review`, `mcp__oc_pilot__scan`, and so on.

### Streamable HTTP

For containers and remote agents, run the same server over HTTP instead of stdio:

```bash
export OC_PILOT_MCP_TOKEN="$(openssl rand -hex 24)"
oc-pilot-mcp --http --host 127.0.0.1 --port 8787 --path /mcp \
  --cwd /workspace --token "$OC_PILOT_MCP_TOKEN"
curl http://127.0.0.1:8787/health
```

HTTP is **read-only by default**: `scan`, `review`, `docgen`, `custom`, and patch-proposal `fix` work; `fix` with `apply: true` and `test_fix` that runs a new command are rejected. Add `--allow-write` only for a trusted, authenticated deployment. `--read-only` forces the same policy for stdio.

The MCP endpoint sets `Mcp-Session-Id` on initialize. When `--token` is set, every request needs `Authorization: Bearer <token>` except `GET /health`. A non-loopback bind **refuses to start** without a token of at least 16 characters. Put a TLS-terminating reverse proxy in front of any public deployment.

### Docker

```bash
export OC_PILOT_MCP_TOKEN="$(openssl rand -hex 24)"
docker build -t oc-pilot-mcp .
docker run --rm -p 8787:8787 \
  -e OC_PILOT_MCP_TOKEN="$OC_PILOT_MCP_TOKEN" \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -v "$PWD:/workspace" \
  oc-pilot-mcp
```

Or use `docker-compose up`; the compose file requires `OC_PILOT_MCP_TOKEN`. The image mounts the current directory at `/workspace` and exposes port 8787. It is read-only over HTTP; set `OC_PILOT_MCP_READ_ONLY=false` only when you trust every client that can reach the endpoint. The image includes OpenCode, so model-backed tools work; `scan` needs no model.

### Agent skills

`skills/oc-pilot/SKILL.md` is an Agent Skill for Claude Code, Codex, and OpenCode. It teaches an agent when to call `scan`, `review`, `test-fix`, `fix`, and `docgen` through MCP or the CLI. Copy the `skills/oc-pilot` directory into your skills directory, or point the client at this repository.

See [docs/integrations.md](docs/integrations.md) for protocols, result shapes, setup details, and shell-only fallbacks.

## CI

```yaml
name: oc-pilot
on: [pull_request]
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install -g oc-pilot
      - run: oc-pilot scan --base origin/${{ github.base_ref }}
      - run: oc-pilot review --base origin/${{ github.base_ref }} --fail-on warning --fail-on-secrets --github
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

`--github` turns parsed findings into inline `::error file=...,line=...` and `::warning` annotations. `scan` needs no API key and is suitable for a fast first gate. Add `--json` instead when a later step needs the structured report.

## Security model

- The built-in repo-context agent is read-only: `read`, `glob`, and `grep` only. `edit`, `shell`, `subagent`, web tools, and external directories are denied.
- Known secret files (`.env`, keys, SSH/AWS credentials, `.npmrc`, `.pypirc`) are denied.
- `--no-repo-context` uses an isolated temporary project with all tools denied and adds full changed files as text.
- Diff, rules, and full-file content are scanned before being sent to the model.
- Project rules and code comments are data, not instructions. The system prompt explicitly treats injected instructions as untrusted.
- The repo-context agent runs inside the analyzed project, so project-level OpenCode config and plugins may load. Use `--no-repo-context` for untrusted repositories.
- Only `fix --apply` writes to the working tree. It rejects patches that touch files outside the reviewed diff, checks the patch with `git apply --check`, runs the configured tests, and reverts the patch when they fail. It never commits or pushes.
- The HTTP transport uses the MCP session header and an optional bearer token. Plain HTTP has no transport encryption; use a TLS proxy for remote deployments, and do not expose it without a token.
- No file is modified by `review`, `test-fix`, `docgen`, or `custom`.

## Limitations

- The quality of the review depends on the selected model and the context budget.
- A diff-only review cannot see every caller; use repo context for contract changes.
- Secret detection is pattern-based and can miss novel formats or produce false positives.
- Auto-detection of test commands may need `--command` / `testCommand`.
- Project-level OpenCode config is not loaded in isolated `--no-repo-context` mode.
- The CLI UI is currently Russian; the model prompt and output are available in English and Russian.
- `fix` works best with text patches. Binary files, renames, and CRLF-sensitive repositories may need a manual `git apply`.
- The HTTP server is single-tenant: anyone with the token can analyze and apply fixes in the mounted workspace. Run one container per trust boundary.
- `setup` edits MCP client config only; it does not install Node, OpenCode, or provider credentials.

## Development

```bash
npm install
npm run check
npm test
npm run prompt:export
```

`npm test` builds first and runs `node --test "dist/**/*.test.js"`.

The project has no runtime dependencies. Dev dependencies are TypeScript and `@types/node`.

## License

MIT
