---
name: commit-discipline
description: Use when an agent has finished a task and needs to commit. Generates a Conventional Commit message from the staged diff, matches the repository's existing history, blocks commits that contain secrets, and commits with a single reviewed command.
---

# Commit discipline

"I updated the code" is not a commit message, and `git add -A && git commit -m
"fix"` hides the one thing a reviewer needs: why. This skill produces a message
derived from the actual diff, in the repository's own style.

## Setup

```bash
npm i -g https://github.com/MyNameIsNikki/oc-pilot/archive/refs/tags/v0.88.0.tar.gz
```

## Workflow

1. **Stage deliberately.** One logical change per commit.

   ```bash
   git add path/to/changed path/to/changed.test
   git status --short
   ```

   Never `git add -A` from an agent session: it picks up scratch files, logs,
   and local config.

2. **Generate the message.**

   ```bash
   oc-pilot commit
   ```

   The command reads the staged diff and the last ten commit subjects, then
   returns a single Conventional Commit message: `type(scope): imperative
   subject` with an optional body. Types: `feat`, `fix`, `docs`, `style`,
   `refactor`, `perf`, `test`, `build`, `ci`, `chore`.

3. **Inspect before applying.** The message must state the behaviour change,
   not the file list. Reject messages that only say "update", "improve", or
   restate the diff.

4. **Commit with the gate.**

   ```bash
   oc-pilot commit --apply
   ```

   `--apply` is allowed only with staged changes. If the staged diff contains a
   critical secret, the command exits `3` and does not commit. Use
   `--allow-secrets` only when you have confirmed the value is public, and say
   so in the PR.

5. **Verify.**

   ```bash
   git log -1 --stat
   ```

   Confirm the commit contains exactly the intended files.

6. **Machine-readable output** for scripts and CI:

   ```bash
   oc-pilot commit --json
   ```

   Returns `message`, `subject`, `body`, `committed`, `diffSource`, `stats`,
   `secrets`, `engine`, `model`, `durationMs`.

## Message rules

- Subject in the imperative mood, 72 characters or fewer, no trailing period.
- Scope names the module, not the file extension.
- Body explains the reason and any migration, wrapped at 72 columns.
- One concern per commit. If the diff mixes a refactor with a behaviour
  change, split it: `git add -p`, then repeat.

## Guardrails

- Do not commit generated artifacts unless the repository tracks them.
- Do not amend or force-push on a shared branch from an agent session.
- If the message does not fit the change, the change is too large or too
  vague — split it instead of inflating the subject.
