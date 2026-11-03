---
name: test-failure-triage
description: Use when a test suite fails and the cause is unclear. Captures the failing output, explains the root cause from the diff and the log, produces a minimal patch, applies it with a snapshot, and verifies the suite is green.
---

# Test failure triage

Most agent failures on red tests are not "the model cannot code". They are
misdiagnosis: the agent patches the assertion instead of the cause, or fixes
the cause but breaks a neighbouring test. This skill forces a root-cause step
before any patch, and a verification step after it.

## Setup

```bash
npm i -g https://github.com/MyNameIsNikki/oc-pilot/archive/refs/tags/v0.17.0.tar.gz
```

## Workflow

1. **Capture the failure verbatim.** Do not summarise it from memory.

   ```bash
   npm test 2>&1 | tee /tmp/test.log; echo "exit=${PIPESTATUS[0]}"
   ```

2. **Ask for the root cause, not for a patch.**

   ```bash
   oc-pilot test-fix --log /tmp/test.log --command "npm test"
   ```

   The output separates the observed failure, the suspected root cause, and a
   minimal fix. If the root cause references code that is not in the diff or
   the log, the model is guessing. Say so and gather that file first.

3. **Propose the patch without touching the tree.**

   ```bash
   oc-pilot fix --command "npm test" --rounds 1
   ```

   Inspect the unified diff. Reject anything that edits test expectations
   without a stated behavioural reason, deletes assertions, or adds sleeps,
   retries, or `skip`.

4. **Apply with a snapshot.**

   ```bash
   oc-pilot fix --apply --command "npm test" --rounds 2
   ```

   A snapshot is created automatically before the patch is applied. If the
   round limit is hit, the tree is reverted to the snapshot.

5. **Verify independently.** Run the suite yourself, not only through the
   tool, and check that the count of passing tests did not drop while the
   failing test turned green.

6. **Roll back if the fix is wrong.**

   ```bash
   oc-pilot restore --list
   oc-pilot restore <snapshot-id>
   ```

   Restore refuses to run if `HEAD` moved since the snapshot, so commit or
   stash first.

## Triage heuristics

| Symptom | Likely cause | Check before patching |
| --- | --- | --- |
| `undefined is not a function` | Wrong import shape or mock | The module's actual export |
| `ECONNREFUSED` / timeouts | Missing fixture or port clash | Test isolation, not the code |
| Snapshot diff | Intentional output change | Whether the change was requested |
| Type error only in CI | Different TS/lib version | `tsconfig`, lockfile drift |
| Flaky pass locally | Order dependence | Run the file alone, then the suite |

## Guardrails

- Never mark a failing test as skipped to close the task.
- Never weaken an assertion unless the expected behaviour genuinely changed;
  if it did, update the test in its own commit with an explanation.
- If the suite takes longer than the timeout, raise `--timeout` rather than
  removing tests.
- Report the failing test name, the root cause, the patch summary, and the
  final suite status.
