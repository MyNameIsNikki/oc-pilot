# oc-pilot

[![npm](https://img.shields.io/npm/v/oc-pilot?style=flat-square&color=black)](https://www.npmjs.com/package/oc-pilot)
[![Node.js](https://img.shields.io/node/v/oc-pilot?style=flat-square&color=black)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-black?style=flat-square)](LICENSE)

Local AI code review, failing-test analysis, documentation generation, and secret scanning for agent CLIs.

`oc-pilot` is a small CLI and MCP server for developers who write code with AI agents. It reviews an uncommitted diff, follows the project beyond the changed lines, catches leaked credentials before they reach a model, explains a failing test, and returns findings as human-readable Markdown or machine-readable JSON.

It works with OpenCode out of the box, with any OpenAI-compatible API (OpenAI, DeepSeek, Groq, OpenRouter, Ollama), and with any MCP-capable agent: Claude Code, OpenAI Codex CLI, Cursor CLI, Gemini CLI, and others.

[English](README.md) | [Русская документация](README.ru.md) | [MCP integrations](docs/integrations.md) | [Security](SECURITY.md) | [Contributing](CONTRIBUTING.md) | [Changelog](CHANGELOG.md)

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
- OpenCode 2.x for the default repo-aware engine, **or** an OpenAI-compatible API endpoint and key.
- Any MCP client for the server workflow.

## Install

From npm. The latest published release is **0.5.1**:

```bash
npm install -g oc-pilot
```

From the repository, pinned to a release tag. Tag **v0.5.2** is a version-only release with identical runtime behavior:

```bash
npm install -g https://github.com/MyNameIsNikki/oc-pilot/archive/refs/tags/v0.5.2.tar.gz
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

During development, run `node dist/cli.js` and `node dist/mcp.js` directly.

## Quick start (OpenCode)

```bash
cd /path/to/project

# Configure every MCP client detected on this machine
oc-pilot setup

# Check installation, engine, key, git and MCP configs
oc-pilot doctor

# Fast offline gate, then model-backed review
oc-pilot scan
oc-pilot review --staged --fail-on-secrets
oc-pilot review --base main --fail-on warning --json

# No OpenCode? Use any OpenAI-compatible endpoint
export OC_PILOT_API_KEY="..."
oc-pilot review --engine openai --model deepseek-chat

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
5. With the OpenCode engine, a read-only agent can use `read`, `glob`, and `grep` to inspect call sites and contracts. `edit`, `shell`, web access, and external directories are denied.
6. The model returns a fixed Markdown schema. `oc-pilot` parses severity and emits JSON on request.
7. `--fail-on` and `--fail-on-secrets` turn findings into CI exit codes.

With `--no-repo-context`, the agent gets no tools. `oc-pilot` instead includes full changed files (`FULL_FILE_CONTEXT`) within the context budget.

## Engines

Choose where the model call goes. `opencode` is the default and gives the best review because the agent can read call sites and contracts. `openai` removes the OpenCode dependency: it calls any OpenAI-compatible `/chat/completions` endpoint and automatically includes the full changed files as context.

```bash
# Default: repo-aware OpenCode agent
oc-pilot review

# Any OpenAI-compatible API, no OpenCode required
export OC_PILOT_API_KEY="..."
oc-pilot review --engine openai --model deepseek-chat \
  --base-url https://api.deepseek.com/v1

# Local model through Ollama (no key needed on loopback)
oc-pilot review --engine openai --model qwen2.5-coder \
  --base-url http://127.0.0.1:11434/v1
```

| Engine | Best for | Repository tools | Requires |
| --- | --- | --- | --- |
| `opencode` | Cross-file bugs and contract changes | Read, glob, grep (read-only) | OpenCode + provider auth |
| `openai` | Zero extra CLIs, CI, DeepSeek/OpenRouter/local models | No; full changed files are included | API endpoint and key |

The key is read from `OC_PILOT_API_KEY`, or `OPENAI_API_KEY` when the default variable name is used. Set `apiKeyEnv` to use another variable. Logs and errors never print the key. With the `openai` engine, `repoContext` is forced off and `FULL_FILE_CONTEXT` is added automatically.

### Smart slicing (`openai`)

When a diff is too large for a single prompt (300 000 characters), the `openai` engine does not truncate files away. Instead it groups the per-file diff blocks into slices that each fit the budget, runs one API call per slice with the same additional context, and merges the responses back into a single schema-compliant analysis (`meta.slices` shows how many calls were made). A single file whose diff exceeds the budget is sent as its own slice and only then truncated. Slicing applies to `review`, `test-fix`, `custom` and `commit --engine openai`; `fix` keeps a single prompt because it must return one patch.

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
| `--no-snapshot` | Skip the safety snapshot before applying |

`fix` never commits or pushes. The patch is reverted when tests fail unless `--keep-on-test-failure` is used. Unrelated working-tree changes are not reverted.

Before applying, `fix` saves a snapshot under `.git/oc-pilot/snapshots/` (tracked changes as a binary patch plus copies of untracked files). Snapshots stay local: they are never committed or pushed. Restore the snapshot with `oc-pilot restore`; skip it with `--no-snapshot`.

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

# SARIF 2.1.0 for GitHub Code Scanning
oc-pilot scan --staged --format sarif -o oc-pilot.sarif
```

Exit 1 means critical secrets were found. `--strict` also fails on warnings. `--format sarif` writes a SARIF 2.1.0 report (rules `oc-pilot/secret`, `oc-pilot/critical`, `oc-pilot/warning`) that GitHub Code Scanning can upload; secret previews stay redacted.

### `commit`

Generates a Conventional Commits message from staged changes and optionally commits it. The model also sees the last 10 commit subjects, so the message matches the project's existing style.

```bash
oc-pilot commit               # print the message
oc-pilot commit --apply       # commit staged with the generated message
oc-pilot commit --json        # machine-readable output
```

`--apply` works only with staged changes and is blocked (exit 3) when the diff contains critical secrets; pass `--allow-secrets` to override. With `--engine openai` an oversized diff is split into per-file slices (see Engines) and the message covers all of them.

### `install-hook`

Installs native git hooks without husky or any dependency. The managed `pre-commit` hook runs `oc-pilot scan --staged`; `--pre-push` also installs a `pre-push` hook that runs `oc-pilot review --fail-on critical --fail-on-secrets`.

```bash
oc-pilot install-hook
oc-pilot install-hook --pre-push
oc-pilot install-hook --uninstall
```

Hooks are opt-in and reversible. A hook that does not belong to oc-pilot is never overwritten unless `--force` is passed, and then the old file is kept as `<hook>.oc-pilot.bak`. Set `OC_PILOT_SKIP=1` to bypass the hooks for a single command. `core.hooksPath` and worktrees are respected.

### `restore`

Restores the working tree from the latest snapshot taken before `fix --apply`.

```bash
oc-pilot restore          # latest snapshot
oc-pilot restore --list   # list saved snapshots
oc-pilot restore <id>     # a specific snapshot
```

Snapshots live under `.git/oc-pilot/snapshots/` and never enter commits. Restore refuses to run when the branch head has moved since the snapshot, so committed work is never lost. The staged/unstaged split is not restored, and untracked files created after the snapshot are not deleted.

### `setup`

Configures an MCP client to launch `oc-pilot-mcp`. Existing server entries and unrelated settings are preserved. It writes configs for Claude Code, Codex, Cursor, Gemini CLI, OpenCode, VS Code, Windsurf, ZCode, and any client that reads `.agents/mcp.json`. By default it points at the current installation; `--npx` writes a version-pinned `npx -y oc-pilot@<version> mcp` entry instead. Generated servers start read-only; add `--allow-write` if the agent should apply patches and run tests.

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
  --http https://oc-pilot.example.com/mcp --token "$OC_PILOT_MCP_TOKEN"
```

| Option | Purpose |
| --- | --- |
| `--client <name>` | `claude`, `codex`, `cursor`, `gemini`, `opencode`, `vscode`, `windsurf`, `zcode`, `agents`; repeatable |
| `--all` | Configure every supported client |
| `--global` | Write user-level config (project is the default) |
| `--local` | Force the current installation path |
| `--npx` | Force a version-pinned `npx` command |
| `--allow-write` | Let the client apply patches and run tests |
| `--print` | Print the config instead of writing it |
| `--json` | JSON plan for automation |
| `--http <url>` | Configure a remote Streamable HTTP endpoint |
| `--token <value>` | Enable bearer auth; the client reads the secret from `OC_PILOT_MCP_TOKEN` |
| `--cwd <dir>` | Project directory stored in the server args |
| `--force` | Replace an existing `oc-pilot` entry |

`setup` never writes the bearer token into a client config. It writes an `OC_PILOT_MCP_TOKEN` reference; export the secret in the environment that launches the client.

`setup` writes only MCP client config. It does not install packages or change your source. With no `--client`, it detects Claude Code, Codex, Cursor, Gemini CLI, OpenCode, VS Code, Windsurf, ZCode, and `.agents` clients from installed commands and config directories.

### `doctor`

One command that explains why a setup is not working:

```bash
oc-pilot doctor
oc-pilot doctor --json
oc-pilot doctor --engine openai --model deepseek-chat
```

It checks Node, the active engine, API credentials, git and repository state, the detected test command, project rules, and every MCP client config. Errors return exit code 1; `--strict` also fails on warnings. No secret values are printed.

### `init`

```bash
oc-pilot init
```

Creates `.oc-pilot.json`. It does not overwrite an existing config unless `--force` is passed.

## Common options

| Option | Default | Purpose |
| --- | --- | --- |
| `-C, --cwd <dir>` | current directory | Project directory |
| `-m, --model <id>` | engine default | Model id (`provider/model` for OpenCode) |
| `--engine <name>` | `opencode` | `opencode` or `openai` (any compatible API) |
| `--base-url <url>` | `https://api.openai.com/v1` | OpenAI-compatible endpoint |
| `--api-key-env <name>` | `OC_PILOT_API_KEY` | Environment variable holding the API key |
| `--agent <name>` | `oc-pilot` | Use another OpenCode agent |
| `--lang <en\|ru>` | `en` | Model-facing prompt and output language |
| `--no-repo-context` | off | Diff-only mode; no repository tools |
| `--rules <path>` | `.oc-pilot/rules.md` | Project rules file |
| `--fail-on <level>` | `none` | Exit 3 on `critical`, `warning`, or `style` findings |
| `--max-diff <size>` | `120000` | Diff/context budget |
| `--max-file <size>` | `60000` | Per-file budget for docgen |
| `--timeout <duration>` | `300` | Model/test timeout; supports `5m` |
| `-o, --output <path>` | stdout | Write the result to a file |
| `--format <f>` | `text` | Output format: `text`, `json`, `sarif` (`scan`, `review`) |
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
- JWTs, credentials in URLs, and sensitive `.env` assignments;
- high-entropy assignments (Shannon entropy over 4 bits for values of 20+ characters) reported as critical.

To silence a false positive, add path globs to `.oc-pilot/ignore` (one per line, `#` starts a comment), or append the inline marker to the source line:

```
# .oc-pilot/ignore
fixtures/**
docs/examples/**

# inline, any language
const TOKEN = "sk-proj-..."; // oc-pilot:ignore-secret
```

Ignore rules are path- and line-scoped, apply to every scanning point (diff, rules, docgen, full-file context), and never disable scanning for the rest of the project.

Detected values never appear in full in logs or JSON. The model receives `[REDACTED:<kind>]` and a masked preview. Review the provider's data policy before sending proprietary code.

`--no-secret-scan` and `redactSecrets: false` disable this protection for the diff, rules, and `FULL_FILE_CONTEXT`. Use them deliberately.

## Output and exit codes

Markdown response:

```markdown
### Analysis: Short conclusion.

#### Findings / Actions
- **Critical `wallet.go:10`**: nil pointer dereference.

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
    "engine": "opencode",
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
  "engine": "opencode",
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

For the API engine, set `"engine": "openai"`, `"model": "deepseek-chat"`, `"baseUrl": "https://api.deepseek.com/v1"`, and optionally `"apiKeyEnv": "DEEPSEEK_API_KEY"` in the same file.

Environment variables: `OC_PILOT_ENGINE`, `OC_PILOT_BASE_URL`, `OC_PILOT_API_KEY_ENV`, `OC_PILOT_MODEL`, `OC_PILOT_AGENT`, `OC_PILOT_LANG`, `OC_PILOT_REPO_CONTEXT`, `OC_PILOT_FAIL_ON`, `OC_PILOT_RULES`, `OC_PILOT_MAX_DIFF_CHARS`, `OC_PILOT_MAX_OUTPUT_CHARS`, `OC_PILOT_MAX_FILE_CHARS`, `OC_PILOT_TIMEOUT_SECONDS`, `OC_PILOT_TEST_COMMAND`, `OC_PILOT_REDACT_SECRETS`.

## MCP server

`oc-pilot-mcp` exposes the same recipes as MCP tools over stdio. This is the recommended way to embed oc-pilot in an agent: the agent calls a tool, and no prompt needs to be copied.

Tools: `review`, `test_fix`, `fix`, `docgen`, `custom`, `scan`. The server is read-only by default; start it with `--allow-write` to permit `fix` with `apply: true` and `test_fix` with a command.

Configure a client automatically:

```bash
oc-pilot setup                      # every detected client
oc-pilot setup --client claude --local
oc-pilot setup --client cursor --global
```

The MCP server uses the configured engine. With `engine: "openai"` and `OC_PILOT_API_KEY` exported in the client's environment, no OpenCode installation is needed.

ZCode can import existing Claude Code, Codex, OpenCode, or `.agents` MCP servers directly, or write its native config with `oc-pilot setup --client zcode`.

Start the server manually with an explicit project directory:

```bash
oc-pilot-mcp --cwd /absolute/path/to/project
# after the npm release, pinned for reproducibility:
npx -y oc-pilot@0.5.2 mcp --cwd /absolute/path/to/project
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

Add `'--allow-write'` to `args` only if the harness may apply patches and run tests. DeepSeek Harness labels the tools as `mcp__oc_pilot__review`, `mcp__oc_pilot__scan`, and so on.

### Streamable HTTP

For containers and remote agents, run the same server over HTTP instead of stdio:

```bash
export OC_PILOT_MCP_TOKEN="$(openssl rand -hex 24)"
oc-pilot-mcp --http --host 127.0.0.1 --port 8787 --path /mcp \
  --cwd /workspace --token "$OC_PILOT_MCP_TOKEN"
curl http://127.0.0.1:8787/health
```

MCP is **read-only by default**, over both stdio and HTTP: `scan`, `review`, `docgen`, `custom`, and patch-proposal `fix` work; `fix` with `apply: true` and `test_fix` that runs a new command are rejected. Add `--allow-write` only for a trusted local client or an authenticated deployment. `oc-pilot setup --allow-write` adds the flag to generated client config.

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

## GitHub Action

The repository ships a composite action, so a pull request gate can be three lines:

```yaml
name: review
on: [pull_request]
jobs:
  oc-pilot:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: MyNameIsNikki/oc-pilot@v0.7.0
        with:
          command: scan
          args: --base origin/${{ github.base_ref }} --fail-on-secrets
```

Inputs: `command` (`scan`, `review`, `test-fix`, `docgen`, `custom`), `args`, `working-directory`, `annotations`, and `version` (install a published npm version instead of the action checkout). `scan` needs no API key. For a model-backed review, set the engine and provider environment variables on the step.

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
      - run: npm install -g https://github.com/MyNameIsNikki/oc-pilot/archive/refs/tags/v0.7.0.tar.gz
      - run: oc-pilot scan --base origin/${{ github.base_ref }}
      - run: oc-pilot review --base origin/${{ github.base_ref }} --fail-on warning --fail-on-secrets --github
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

`--github` turns parsed findings into inline `::error file=...,line=...` and `::warning` annotations. `scan` needs no API key and is suitable for a fast first gate. Add `--json` instead when a later step needs the structured report.

To upload results to GitHub Code Scanning, write a SARIF report and upload it:

```yaml
      - run: oc-pilot scan --base origin/${{ github.base_ref }} --format sarif -o oc-pilot.sarif
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: oc-pilot.sarif
```

## Security model

- The built-in repo-context agent is read-only: `read`, `glob`, and `grep` only. `edit`, `shell`, `subagent`, web tools, and external directories are denied.
- Known secret files (`.env`, keys, SSH/AWS credentials, `.npmrc`, `.pypirc`) are denied.
- `--no-repo-context` uses an isolated temporary project with all tools denied and adds full changed files as text.
- Diff, rules, and full-file content are scanned before being sent to the model.
- Project rules and code comments are data, not instructions. The system prompt explicitly treats injected instructions as untrusted.
- The repo-context agent runs inside the analyzed project, so project-level OpenCode config and plugins may load. Use `--no-repo-context` for untrusted repositories.
- Only `fix --apply` writes to the working tree. It rejects patches that touch files outside the reviewed diff, checks the patch with `git apply --check`, saves a local snapshot under `.git/oc-pilot/snapshots/` before applying, runs the configured tests, and reverts the patch when they fail. It never commits or pushes.
- `install-hook` writes only managed hook files inside the git hooks directory, marks them with a header comment, keeps backups when `--force` replaces a foreign hook, and is fully reversible with `--uninstall`.
- The HTTP transport uses the MCP session header and an optional bearer token. Plain HTTP has no transport encryption; use a TLS proxy for remote deployments, and do not expose it without a token.
- No file is modified by `review`, `test-fix`, `docgen`, or `custom`.

## Limitations

- The quality of the review depends on the selected model and the context budget.
- A diff-only review cannot see every caller; use the OpenCode engine or repo context for contract changes. The `openai` engine sees the full changed files, not arbitrary call sites.
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
