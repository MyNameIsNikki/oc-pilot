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
- `test_gen` — write tests for changed code; with `apply: true`, apply them and run the suite, reverting failures unless `keep_failing`.
- `docgen` — GoDoc/RustDoc/JSDoc/docstrings.
- `slop` — offline Slop Index.
- `mutate` — mutation testing: flips operators, runs tests, lists survivors; needs `--allow-write` because it rewrites sources temporarily.
- `flaky` — repeated and shuffled test runs that flag tests passing in some runs and failing in others.
- `impact` — declarations changed by the diff and every untouched file that still references them.
- `deps` - dependency audit: phantom and missing imports, unused packages, lockfile drift, OSV vulnerabilities and licenses; `fix` and `sbom` need `--allow-write`.
- `coverage` - changed lines missing from a local lcov, Istanbul, Cobertura or Go coverage report, with an optional gate.
- `reviewers` — authors who touched the changed files plus CODEOWNERS owners; accepts `limit`, `depth` and `exclude`.
- `test_guard` — offline test-weakening guard: skipped/focused/deleted tests, removed assertions, matcher downgrades, `@ts-ignore`, empty catch.
- `env_sync` — environment variables added by the diff against `.env` and `.env.example`: missing definitions and undocumented keys.
- `mock_leak` - forgotten stubs and hardcode in production code: local paths, test tokens, always-true conditions, mock identifiers and localhost URLs.
- `ecosystem_verify` - named imports against installed packages and `.d.ts`, plus age and downloads of newly added npm packages.
- `pack` - compact task context: rules, changed-file signatures, related references and an optional test log, capped by `budget` characters; read-only.
- `pack --hologram` - layered context: LOD 0 full diff files, LOD 1 hidden bodies with EFFECTS markers and matching tests, LOD 2 export names; `zoom-symbol` returns one hidden body on demand.
- `contract_drift` - removed or newly required fields and type changes in TypeScript, Zod, Prisma, Pydantic and JSON Schema, plus untouched consumers of a removed field.
- `anti_regression` - lines the diff re-adds after a human explicitly deleted them in git history, with the deleting commit cited.
- `boundaries` - added imports checked against `.oc-pilot/architecture.json` layer rules, with file, line and rule reason.
- `test_plan` — select the test files affected by the diff from the import graph; report uncovered changed files and gate with `fail_on_uncovered`.
- `compliance_verify` — verify the signed audit manifest for HEAD: hash, commit, previous-manifest chain and Ed25519 signature.
- `brag` - self-contained HTML/SVG session report from stats, git history, last review and receipt; inline assets only, no model or network.
- `battle` - experimental coder/hacker loop: the coder patches, the hacker reviews and runs SAST, authz and test-weakening checks until no high findings remain and tests pass.
- `cleanup` - offline cleanup plan from dependency issues, Slop Index, environment variables and weakened tests; `apply` performs only safe dependency fixes and needs `--allow-write`.
- `arch_diff` — Mermaid diagram of added (green) and removed (red) internal imports, with an optional `fail_on_removed` gate.
- `roast` — model-backed comedy roast with linus/ramsay/corporate/default personas; every joke cites file:line and ends with one real fix.
- `cinema` — terminal timelapse of the session from commits, runs, API calls, last review and receipt; self-contained HTML player or asciinema v2 cast.
- `autopsy` — forensic post-mortem for a commit: diff stats, SAST on added lines, weakened tests, mock leaks, ranked suspects and a before/after timeline; `--fail-on-risk` exits 1 on a dangerous verdict.
- `echo` — self-contained SVG badges from local stats/git/receipt, with opt-in anonymous aggregate submit to an explicit endpoint; no network by default.
- `bounty` — ASCII WANTED poster for the worst file scored from SAST, duplicates, dead exports, aged task comments and churn; deterministic and offline.
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
oc-pilot test-gen --staged --apply
oc-pilot fix --apply --command "npm test"
oc-pilot docgen "src/**/*.ts"
oc-pilot mutate --staged --min-score 80
oc-pilot flaky --runs 5 --fail-on-flaky
oc-pilot impact --staged
oc-pilot deps --audit
oc-pilot coverage --staged --coverage-file coverage/lcov.info --fail-under 80
oc-pilot reviewers --base main
oc-pilot test-guard --staged --fail-on-weakening
oc-pilot env-sync --staged --fail-on-missing
oc-pilot mock-leak --staged --fail-on-leak high
oc-pilot ecosystem-verify --staged --fail-on-issue high
oc-pilot pack "fix the login redirect" --staged --budget 12000
oc-pilot pack --hologram --max-tokens 30000 --output context.md
oc-pilot zoom-symbol src/core/pack.ts buildPack
oc-pilot contract-drift --staged --fail-on-drift high
oc-pilot anti-regression --staged --fail-on-regression
oc-pilot boundaries --staged --fail-on-violation
oc-pilot test-plan --staged --fail-on-uncovered
oc-pilot compliance --verify
oc-pilot brag --since-days 30 --output brag.html
oc-pilot battle "fix the retry logic" --apply --rounds 3
oc-pilot cleanup --staged --fail-on-task high
oc-pilot arch-diff --staged --fail-on-removed
oc-pilot roast --staged --persona linus
oc-pilot cinema --since-days 30 --output cinema.html
oc-pilot bounty --limit 10 --since-days 90
oc-pilot autopsy HEAD~1 --depth 10
oc-pilot echo --name my-team --svg --output badges.svg
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
