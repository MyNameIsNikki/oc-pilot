---
name: oc-pilot
description: Local pre-flight review for AI-generated code. Use before committing to review a diff, scan for leaked secrets, explain a failing test, generate docstrings, or propose and apply a tested patch with oc-pilot.
---

# oc-pilot

Use this skill when code was just generated or changed and needs a local check
before it reaches a commit, pull request, or production branch.

## Prefer MCP

If the `oc-pilot` MCP server is configured, call its tools directly:

- `scan` — offline secret scan, no model call.
- `review` — bugs, security issues, idioms, and structured findings.
- `test_fix` — root cause of a failing test plus a minimal fix.
- `fix` — propose a unified diff; with `apply: true`, apply it and run tests, reverting on failure.
- `docgen` — GoDoc/RustDoc/JSDoc/docstrings.
- `slop` — offline Slop Index.
- `mutate` — mutation testing: flips operators, runs tests, lists survivors; needs `--allow-write` because it rewrites sources temporarily.
- `flaky` — repeated and shuffled test runs that flag tests passing in some runs and failing in others.
- `impact` — declarations changed by the diff and every untouched file that still references them.
- `sast` — deterministic static analysis: injection, path traversal, SSRF, XSS, TLS and other dangerous patterns.
- `authz` — route authorization: unauthenticated routes, IDOR lookups, admin paths without a role.
- `preflight` — one offline verdict: secrets, SAST, route authorization, dependency health, test weakening, Slop Index delta.
- `ready` — offline agent readiness score 0-100 across tests, lockfile, hooks, slop, receipt, docs, CI, config and security.
- `receipt_verify` — verify the receipt for HEAD: its hash, recorded commit and whether its tests passed.
- `custom` — any other code question with an optional diff.

Pass `diff` as unified diff **text**. Omit it to let the server use the
project's git diff. Set `fail_on` to `critical`, `warning`, or `style` when the
call should fail the build.

## CLI fallback

```bash
oc-pilot review --fail-on warning --fail-on-secrets
oc-pilot scan --json
oc-pilot test-fix
oc-pilot fix --apply --command "npm test"
oc-pilot docgen "src/**/*.ts"
oc-pilot mutate --staged --min-score 80
oc-pilot flaky --runs 5 --fail-on-flaky
oc-pilot impact --staged
```

Use `--lang ru` for Russian model output. The CLI UI itself may be Russian.

## Related skills

Focused workflows built on the same CLI:

- `agent-self-review` — pre-commit gate loop with a verified exit code.
- `test-failure-triage` — root cause first, then a patch with a snapshot.
- `secure-diff-gate` — secrets, security rules, injection and dependency risks.
- `commit-discipline` — Conventional Commit message from the staged diff.
- `stack-review-packs` — rules packs for 23 languages and frameworks.

## Safety

- Never paste real secrets into a prompt. `oc-pilot` redacts common secrets in
  diffs and project rules, but it is not a guarantee.
- `fix --apply` changes the working tree. Use it only in a clean or disposable
  checkout. It reverts a patch when tests fail, but unrelated changes are not
  reverted.
- In repo-context mode the agent gets read-only `read`, `glob`, and `grep`.
  Use `--no-repo-context` for untrusted repositories.
- Review the proposed patch before committing, even when tests pass.
