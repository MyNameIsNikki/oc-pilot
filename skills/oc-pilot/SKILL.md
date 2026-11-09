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
- `invariants` - semantic lock file `.oc-pilot/invariants.md` checked against the diff with a cheap model; `[CRITICAL]` and `--strict` gate with exit code 3, out-of-scope rules are skipped without a model call.
- `fuzz` - safe JIT fuzzing of exports added by the diff in separate processes; side-effect files are blocked, crashes and timeouts carry the exact input.
- `bankruptcy` - deterministic tech-debt forecast from commit history: smoothed score, slope, forecast date and an SVG chart; test weakening and security dominate the weights.
- `query` - chainable AQL over a lightweight code graph: find, where, sort, limit, select and count; MCP tool `query_ast`.
- `sandbox run` - execute one JS/ESM file in node:vm with imports, require, fetch and process.exit blocked; output and exact status are reported.
- `hivemind` - encrypted TCP mesh: ed25519 identity, trusted peers, ECDH X25519 handshake and AES-256-GCM payloads; only diffs, AST and LLM requests are allowed.
- `honeypot` - deploy decoy files (`.env.backup`, a trapped `bypassAuth`, a legacy DB drop) and fail preflight with `[HONEYPOT TRIGGERED]` when an agent reads or changes one; `status` lists traps and `remove` deletes only marker files.
- `alien-dna` - compare added diff lines with the architecture DNA at HEAD and fail with `[ALIEN DNA DETECTED]` when a Singleton, Proxy, dynamic RegExp, eval, global state, inheritance, decorator, Worker, EventEmitter, dynamic import, sync I/O or prototype mutation has 0% prior occurrence.
- `hyper-chamber` - age one JS/ESM file in node:vm with fake time and forced GC, sample the heap through node:v8 and fail with `[MEMORY LEAK DETECTED]` on sustained growth; the file must export `run`, `tick`, `main` or `default`.
- `butterfly` - run the test command under deterministic chaos: fetch 500s, latency and broken JSON, fs EIO under `--scope`; report injected faults and whether the suite survived.
- `blindfold` - obfuscate identifiers, send only the stripped code to the model and fail with `[BLINDFOLD REJECTED]` when the logic is unclear, a vulnerability is found or confidence is below `--min-confidence`; `--dry-run` prints the mapping without a model call.
- `skeptic` - ask the model for a minimal executable test, run it in a shadow worktree on both the diff and clean HEAD, and report `clean`, `bug`, `unfalsifiable` or `error`; a passing test never proves the absence of bugs.
- `antibody` - learn SAST findings into `.oc-pilot/antibodies.json` signatures, scan added diff lines for known bad patterns and fail with `[ANTIBODY MATCH]`; `learn`, `forget` and `clear` write, so MCP needs `--allow-write`.
- `polygraph` - extract the claims from a commit or PR message, check each against the diff and report `supported`, `contradicted` or `unverifiable`; `[CLAIM CONTRADICTED]` exits 1, and `supported` only means consistent with the diff.
- `passport` - record the commit, file hashes, agent, model and real checks in `.oc-pilot/passport.json`, bind them with a digest and verify with `passport verify`; `[PASSPORT STALE]` and `[PASSPORT TAMPERED]` mean the manifest no longer matches, and write/clear need `--allow-write`.
- `oracle` - run the same JSON corpus against HEAD and the diff in two shadow worktrees, compare stdout and exit codes and report `[BEHAVIOR CHANGED]` with the exact input; the command must contain `{input}` and a same result covers only the supplied corpus.
- `vaccine` - turn a fixed bug into a regression test: `create --fix HEAD` asks the model for one test and proves it fails on the buggy parent and passes on the fix in two shadow worktrees; only verified vaccines are stored, `run` replays them on HEAD, and create/forget/clear need `--allow-write`.
- `mitosis` - split a large diff into small commits by file, directory or type; `plan` is read-only, `apply --confirm` commits each group in a shadow worktree, optionally runs tests after each and exposes a branch plus patches; a failing commit stops the branch for inspection.
- `intent` - check acceptance criteria against the diff (`met`, `partial`, `unmet`, `unverifiable`, exit 1 on unmet) or interrogate a request before code with `sphinx` (`[REQUIREMENTS AMBIGUOUS]` when questions or assumptions remain).
- `scalpel` - fix a failing test with the smallest patch: `--log` or `--command` reproduces the failure, the model proposes a patch, the current diff plus the patch are verified in a shadow worktree, and the blast radius lists touched symbols and references; `--apply` writes only a proven patch.
- `mayday` - incident response: `bisect --good <ref> --bad <ref> --command <cmd>` finds the first failing commit; `rollback --to <ref> --confirm` reverts the range in a shadow worktree, runs tests and exposes a branch; never reset --hard or force-push.
- `apoptosis` - scan functions marked `/* @lifespan: 30d */`; report `[Senescent]` when the marker is older than the lifespan and there are no references, and only with `apply --confirm` comment them out in a shadow worktree, run tests and land the diff if green.
- `injection` - scan README, docs, comments, HTML and source for prompt-injection, role hijacks, exfiltration URLs, hidden unicode and base64 instructions; `--fail-on` controls the gate and `--fix` strips invisible characters.
- `contract_drift` - removed or newly required fields and type changes in TypeScript, Zod, Prisma, Pydantic and JSON Schema, plus untouched consumers of a removed field.
- `anti_regression` - lines the diff re-adds after a human explicitly deleted them in git history, with the deleting commit cited.
- `boundaries` - added imports checked against `.oc-pilot/architecture.json` layer rules, with file, line and rule reason.
- `test_plan` — select the test files affected by the diff from the import graph; report uncovered changed files and gate with `fail_on_uncovered`.
- `compliance_verify` — verify the signed audit manifest for HEAD: hash, commit, previous-manifest chain and Ed25519 signature.
- `brag` - self-contained HTML/SVG session report from stats, git history, last review and receipt; inline assets only, no model or network.
- `battle` - experimental coder/hacker loop: the coder patches, the hacker reviews and runs SAST, authz and test-weakening checks until no high findings remain and tests pass.
- `fix --shadow` / `battle --shadow` - run apply in a detached `.oc-pilot/shadow-tree` worktree and land the diff only after a successful run.
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
oc-pilot invariants --staged --fail-on violation
oc-pilot fuzz --duration 2s --memory-limit 128MB
oc-pilot bankruptcy --history 30d --format json
oc-pilot query "find(CallExpression).where(name, 'stripe').select(file, line)"
oc-pilot sandbox run scripts/demo.mjs --timeout 500ms
oc-pilot hivemind init
oc-pilot honeypot deploy
oc-pilot alien-dna --staged
oc-pilot hyper-chamber run scripts/task.mjs
oc-pilot butterfly --command "npm test"
oc-pilot blindfold --file src/checkout.ts
oc-pilot antibody learn
oc-pilot antibody scan --staged
oc-pilot polygraph --commit HEAD
oc-pilot passport write --commit HEAD --check preflight=pass
oc-pilot oracle --command "node harness.mjs {input}" --input corpus.json --staged
oc-pilot vaccine create --fix HEAD --context "what broke"
oc-pilot vaccine run
oc-pilot mitosis plan --strategy type
oc-pilot mitosis apply --staged --confirm --branch oc-pilot/split
oc-pilot intent check --criteria docs/acceptance.md --staged
oc-pilot intent sphinx --request "what to build"
oc-pilot scalpel --log test-failure.log
oc-pilot scalpel --command "npm test" --apply
oc-pilot mayday bisect --good v1.2.0 --bad HEAD --command "npm test"
oc-pilot mayday rollback --to v1.2.0 --confirm
oc-pilot skeptic --staged
oc-pilot apoptosis scan --fail-on-senescent
oc-pilot injection --fail-on medium
oc-pilot contract-drift --staged --fail-on-drift high
oc-pilot anti-regression --staged --fail-on-regression
oc-pilot boundaries --staged --fail-on-violation
oc-pilot test-plan --staged --fail-on-uncovered
oc-pilot compliance --verify
oc-pilot brag --since-days 30 --output brag.html
oc-pilot battle "fix the retry logic" --apply --rounds 3
oc-pilot battle "harden auth" --apply --shadow
oc-pilot fix --apply --shadow
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
