import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PilotError } from "./errors.js";
import { runGit } from "./git.js";
/** Creates a detached git worktree at .oc-pilot/<name>, based on HEAD. */
export function createShadow(cwd, name = "shadow-tree") {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
        throw new PilotError("Некорректное имя shadow worktree", { exitCode: 2 });
    }
    const dir = join(cwd, ".oc-pilot", name);
    const check = runGit(["rev-parse", "--verify", "HEAD"], cwd);
    if (check.status !== 0) {
        throw new PilotError("Shadow worktree требует хотя бы один коммит", {
            hint: "Сделайте первый коммит или уберите --shadow.",
            exitCode: 2,
        });
    }
    if (existsSync(dir)) {
        runGit(["worktree", "remove", "--force", dir], cwd);
        rmSync(dir, { recursive: true, force: true });
    }
    mkdirSync(dirname(dir), { recursive: true });
    const add = runGit(["worktree", "add", "--detach", dir, "HEAD"], cwd);
    if (add.status !== 0) {
        throw new PilotError("Не удалось создать shadow worktree", {
            hint: add.stderr.trim() || add.stdout.trim() || undefined,
            exitCode: 2,
        });
    }
    let cleaned = false;
    return {
        dir,
        cleanup: () => {
            if (cleaned)
                return;
            cleaned = true;
            runGit(["worktree", "remove", "--force", dir], cwd);
            rmSync(dir, { recursive: true, force: true });
        },
    };
}
/** Stages everything in the shadow tree and returns a binary-safe patch. */
export function shadowDiff(shadowDir) {
    runGit(["add", "-A"], shadowDir);
    const diff = runGit(["diff", "--cached", "--binary", "--no-color", "HEAD"], shadowDir);
    return diff.status === 0 ? diff.stdout : "";
}
/** Applies the shadow patch to the real tree only after a successful run. */
export function applyShadowDiff(cwd, diff) {
    if (!diff.trim())
        return { ok: true, files: 0 };
    const files = diff.split(/\r?\n/).filter((line) => line.startsWith("diff --git ")).length;
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-shadow-"));
    const patch = join(dir, "shadow.patch");
    try {
        writeFileSync(patch, diff, "utf8");
        const check = runGit(["apply", "--check", patch], cwd);
        if (check.status !== 0) {
            return { ok: false, files, error: check.stderr.trim() || check.stdout.trim() || "git apply --check failed" };
        }
        const apply = runGit(["apply", patch], cwd);
        if (apply.status !== 0) {
            return { ok: false, files, error: apply.stderr.trim() || apply.stdout.trim() || "git apply failed" };
        }
        return { ok: true, files };
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
/** Writes the original diff to a temp file so the inner command can read it. */
export function writeShadowDiff(diff) {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-shadow-input-"));
    const path = join(dir, "input.diff");
    writeFileSync(path, diff, "utf8");
    return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
export function readPatch(path) {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
}
/** Removes flags that describe the real tree so the inner command reads one diff. */
export function stripShadowArgs(argv) {
    const out = [];
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--shadow" || arg === "--staged" || arg === "--unstaged" || arg === "--include-untracked")
            continue;
        if (arg === "--diff" || arg === "--base" || arg === "--cwd") {
            index += 1;
            continue;
        }
        out.push(arg);
    }
    return out;
}
//# sourceMappingURL=shadow.js.map