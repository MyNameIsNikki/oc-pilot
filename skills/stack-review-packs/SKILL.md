---
name: stack-review-packs
description: Use when setting up review rules for a new repository or a new stack. Installs a curated rules pack for one of 23 languages and frameworks, combines packs, and wires the same rules into the CLI, MCP server, and CI.
---

# Stack review packs

A generic reviewer says "consider error handling". A reviewer that knows the
stack says "this `async` handler returns a floating promise, and the Express 4
router will not catch it". Rules packs are how the second reviewer happens.

## Setup

```bash
npm i -g https://github.com/MyNameIsNikki/oc-pilot/archive/refs/tags/v0.36.0.tar.gz
```

## Available packs

| Area | Ids |
| --- | --- |
| General | `base`, `typescript`, `security`, `devops` |
| JavaScript | `node`, `react`, `next`, `vue`, `svelte`, `angular` |
| Backend | `python`, `go`, `rust`, `java`, `kotlin`, `csharp`, `php`, `ruby` |
| Mobile | `swift`, `flutter` |
| Other | `elixir`, `zig`, `scala` |

## Install

```bash
oc-pilot init --preset react,typescript,security
oc-pilot init --preset python,devops --force
```

Several packs are joined under one header in `.oc-pilot/rules.md`, which is
included in every review, fix, and docgen request. The file is plain Markdown:
add project-specific constraints at the end, for example "money is integer
cents", "do not log request bodies", "migrations must be reversible".

## Verify the rules are actually used

```bash
oc-pilot review --staged --json
```

Check `meta.rules` in the JSON: it contains the resolved rules path, or `null`
when no file was found. A rules file that is silently ignored is worse than
none.

## Keep the same rules everywhere

- **CLI** — reads `.oc-pilot/rules.md` automatically; override with `--rules`.
- **MCP server** — expose the file as the `oc-pilot://rules` resource so the
  host agent can read it, and it is applied to every MCP review call.
- **CI** — commit the file; the GitHub Action and the pre-commit hooks use the
  same path.
- **Agents** — `AGENTS.md` and `CLAUDE.md` are picked up automatically as an
  additional context block. Keep stack rules in `.oc-pilot/rules.md` and
  workflow rules in the agent file, so neither duplicates the other.

## Writing a pack

A good pack has three sections and no adjectives:

1. **What breaks** — concrete failure modes for this stack.
2. **What is unsafe** — injection sinks, auth boundaries, secret exposure.
3. **What rots** — patterns that pass review now and cost later.

One line per rule, imperative, no "consider" or "try to". If a rule cannot be
checked by reading a diff, drop it.

## Guardrails

- Do not enable every pack; irrelevant rules dilute attention and cost tokens.
- Do not copy rules between stacks without adapting the failure modes.
- Re-read the pack after a framework major upgrade; idioms expire.
