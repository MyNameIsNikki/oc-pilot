# Agensi listing plan

Marketplace copy for [agensi.io](https://agensi.io). Non-exclusive listing; the
CLI stays MIT and free. Skills are thin wrappers that require the published
`oc-pilot` CLI, so buyers pay for the workflow, not for access to the code.

## Products

| Skill | Directory | Price | Role |
| --- | --- | --- | --- |
| Agent self-review | `skills/agent-self-review` | Free | Lead magnet, drives installs |
| Commit discipline | `skills/commit-discipline` | Free | Lead magnet |
| Stack review packs | `skills/stack-review-packs` | Free | Lead magnet, shows depth |
| oc-pilot | `skills/oc-pilot` | Free | Entry point, MCP wiring |
| Test failure triage | `skills/test-failure-triage` | $19 | Paid |
| Secure diff gate | `skills/secure-diff-gate` | $29 | Paid |
| Agent quality gate (bundle) | all of the above | $39 | Paid bundle |

Rationale: the free tier must be genuinely useful on its own, otherwise
installs do not convert. The paid tier sells the workflows that prevent an
incident or a wasted debugging session, which is where willingness to pay is
measurable.

## Listing fields

**Name** — Agent self-review (or the bundle: Agent Quality Gate)

**Short description (under 160 characters)**
> Make your coding agent review its own diff before it commits: secret scan,
> independent review, a fix loop, and a green exit code you can trust.

**Long description**
> Coding agents ship mistakes faster than humans can review them. This skill
> gives the agent a pre-commit gate it must clear: an offline secret scan, an
> independent review of the exact staged diff, a bounded fix loop with a
> snapshot for rollback, and a re-verification pass that must end with exit
> code 0.
>
> It does not replace your reviewer. It removes the diff that was never checked
> by anyone before it asked for a human opinion. Works with Claude Code,
> Cursor, Copilot, Codex, Gemini CLI, OpenCode and any agent that can run a
> shell command. No account, no cloud storage: findings, snapshots, baseline
> and cache stay inside the repository's `.git` directory.

**Categories** — Developer tools, Code review, Security, Testing, Git

**Tags** — code review, pre-commit, secret scanning, SARIF, test failures,
conventional commits, local-first, agent workflow

**Requirements**
- Node.js 22 or newer
- A git repository for diff-based commands
- One engine: OpenCode (local, no key) or any OpenAI-compatible API endpoint

**Install**
```bash
npm i -g https://github.com/MyNameIsNikki/oc-pilot/archive/refs/tags/v0.11.1.tar.gz
cp -r skills/agent-self-review ~/.claude/skills/agent-self-review
```

**Support** — GitHub issues. Refunds per marketplace policy; the free skills
make the paid ones testable before purchase.

## Affiliate

Use the platform-issued link in the repository README, the npm page, and posts
about the release. Do not gate the affiliate link behind the paid skills: the
referral applies to first purchases and to anything else the user buys.

## What not to do

- Do not sell "oc-pilot itself" as a product. It is MIT and installable for
  free; a listing that implies otherwise damages trust.
- Do not promise model-quality guarantees. The gate detects categories
  (secrets, injection, risky dependencies, missing tests), not correctness.
- Do not bundle a pinned CLI version without a note that the CLI is published
  separately.
