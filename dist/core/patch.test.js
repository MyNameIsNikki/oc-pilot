import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { applyPatch, checkPatch, extractPatch, patchTargets, revertPatch } from "./patch.js";
const PATCH = [
    "diff --git a/hello.txt b/hello.txt",
    "--- a/hello.txt",
    "+++ b/hello.txt",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "",
].join("\n");
test("extractPatch finds fenced and raw unified diffs", () => {
    assert.equal(extractPatch(`### Analysis: fix\n\n#### Solution\n\`\`\`diff\n${PATCH}\`\`\``), PATCH.trim());
    assert.equal(extractPatch(`\`\`\`patch\n${PATCH}\`\`\``), PATCH.trim());
    assert.equal(extractPatch(`prose\n${PATCH}`), PATCH.trim());
    assert.equal(extractPatch("### Analysis: no patch"), undefined);
});
test("patchTargets reads changed paths and ignores /dev/null", () => {
    assert.deepEqual(patchTargets(PATCH), ["hello.txt"]);
    assert.deepEqual(patchTargets(["--- /dev/null", "+++ b/new file.txt", ""].join("\n")), ["new file.txt"]);
    assert.deepEqual(patchTargets([
        "diff --git a/old.txt b/old.txt",
        "deleted file mode 100644",
        "--- a/old.txt",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-gone",
        "",
    ].join("\n")), ["old.txt"]);
    assert.deepEqual(patchTargets(["diff --git a/logo.png b/logo.png", "GIT binary patch", ""].join("\n")), ["logo.png"]);
});
test("patchTargets ignores header-like lines inside a hunk", () => {
    const patch = [
        "--- a/notes.txt",
        "+++ b/notes.txt",
        "@@ -1,2 +1,2 @@",
        "--- not a header",
        "+++ not a header",
        "",
    ].join("\n");
    assert.deepEqual(patchTargets(patch), ["notes.txt"]);
});
test("git apply check, apply and revert round-trip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-patch-"));
    try {
        spawnSync("git", ["init", "-q"], { cwd: dir });
        writeFileSync(join(dir, "hello.txt"), "a\n", "utf8");
        spawnSync("git", ["add", "hello.txt"], { cwd: dir });
        spawnSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "init"], {
            cwd: dir,
        });
        const checked = await checkPatch(dir, PATCH);
        assert.equal(checked.exitCode, 0, checked.stderr);
        const applied = await applyPatch(dir, PATCH);
        assert.equal(applied.exitCode, 0, applied.stderr);
        assert.equal(readFileSync(join(dir, "hello.txt"), "utf8").replace(/\r\n/g, "\n"), "b\n");
        const reverted = await revertPatch(dir, PATCH);
        assert.equal(reverted.exitCode, 0, reverted.stderr);
        assert.equal(readFileSync(join(dir, "hello.txt"), "utf8").replace(/\r\n/g, "\n"), "a\n");
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=patch.test.js.map