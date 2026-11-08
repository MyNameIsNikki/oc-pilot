---
name: agent-self-review
description: Use before committing or handing off AI-generated code. Runs a local secret scan and an independent review of the staged diff, fixes blocking findings, and re-verifies until the diff is clean or the remaining issues are explicitly documented.
---

# Agent self-review

A coding agent should not ask a human to review code it never checked itself.
This skill turns "I think it works" into a verified claim: secrets scanned,
diff reviewed by a second model, blocking findings fixed, exit code checked.

## Setup

```bash
npm i -g https://github.com/MyNameIsNikki/oc-pilot/archive/refs/tags/v0.95.0.tar.gz
oc-pilot --version   # requires 0.11+
```

Works with no API key when OpenCode is the configured engine. For a hosted
model, export a key and pass `--engine openai --model <id>`.

## Workflow

1. **Scan secrets first.** This is offline and instant, so it costs nothing to
   run before any model call.

   ```bash
   oc-pilot scan --staged --json
   ```

   Exit `3` means critical secrets are present. Stop and remove them; do not
   "fix" them by rewriting history you have not inspected.

2. **Review the exact diff that will be committed.**

   ```bash
   oc-pilot review --staged --fail-on critical --fail-on-secrets
   ```

   Read the `#### Замечания / Findings` section. Every bullet has a severity
   and a `file:line` location. Treat `critical` as blocking. Warnings are a
   judgement call; styles are optional.

3. **Fix only what was found.** Feed the findings back into the same code you
   just wrote, not into a rewrite. Prefer the smallest change that removes the
   defect.

   ```bash
   oc-pilot fix --apply --command "npm test"
   ```

   `fix` proposes a unified diff, checks it with `git apply --check`, applies
   it, runs tests, and reverts the patch if tests fail. A snapshot is written
   before applying, so `oc-pilot restore` can roll back.

4. **Re-verify.** A fix is not done until the gate is green again.

   ```bash
   oc-pilot review --staged --fail-on critical --fail-on-secrets
   ```

   Repeat steps 3–4 at most twice. If the same finding survives two attempts,
   stop and report it to the user with the file, line, and why it is hard to
   fix. Do not loop silently.

5. **Report.** In the final message state: what was reviewed, what was fixed,
   what remains, and the exit code of the last run.

## Reading the result

| Exit | Meaning | Agent action |
| --- | --- | --- |
| `0` | No findings at or above the threshold | Proceed to commit |
| `3` | Policy gate failed (findings or secrets) | Fix, then re-run |
| `1` | Runtime error (engine, network, git) | Report, do not guess |
| `2` | Bad arguments | Fix the command |

## Rules of engagement

- Never disable the gate to make it pass. No `--no-secret-scan`, no
  `--fail-on none`, no deleting `.oc-pilot/ignore` entries.
- If a finding is a false positive, hide it deliberately with
  `oc-pilot review --staged --interactive` and say so in the report.
- Do not commit generated lockfiles, vendored trees, or fixtures that the
  review was told to ignore.
- If the repository has project rules in `.oc-pilot/rules.md`, do not edit
  them to silence a finding.
