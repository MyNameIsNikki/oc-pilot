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

## Submission format

Agensi takes one zip per listing: `SKILL.md` at the archive root, valid
frontmatter with `name` and `description`, plus any scripts, references and
assets. Up to 50 MB.

Build all archives from the repository:

```bash
pwsh scripts/build-skills.ps1            # writes dist-skills/*.zip
pwsh scripts/build-skills.ps1 -OutDir out
```

The script packs the *contents* of each `skills/<name>/` directory, so the
archive root is exactly `SKILL.md` — not `agent-self-review/SKILL.md`.
Current bundles: `agent-self-review`, `commit-discipline`, `oc-pilot`,
`secure-diff-gate`, `stack-review-packs`, `test-failure-triage`, about 1-2 KB
each because every skill is a single document that drives the CLI.

`dist-skills/` is generated output and stays out of git.

## Payouts

- Stripe pays to your own account instantly where Stripe operates.
- Where Stripe does not operate, Agensi uses Zoneless: USDC on Solana to your
  own wallet within 72 hours, onboarded separately.
- There is no Wise, wire transfer or direct bank route.
- A free listing needs no payout setup.

Practical consequence: publish the free skills first. They need no payout
account and they establish the listing graph and install counts. Enable the
paid SKUs ($19 triage, $29 security gate, $39 bundle) only after Zoneless is
connected, so the first sale is not stuck behind onboarding.

## Open questions for Agensi

These are unanswered and worth confirming before paying for promotion:

1. Moderation: is there a review step, a quality bar, and what causes a
   rejection?
2. Analytics: are installs, conversions and refunds exposed per skill?
3. Versioning: when a skill changes, is the listing edited in place or is a new
   archive uploaded, and does the previous version stay available?
4. Dependencies: is a documented `npm i -g` requirement in `SKILL.md`
   acceptable, or are self-contained bundles expected?
5. Multi-agent manifests: which agents consume `SKILL.md` unmodified, and which
   need a sidecar manifest?
