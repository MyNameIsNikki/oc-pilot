import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyShadowDiff, createShadow, shadowDiff, stripShadowArgs } from "./shadow.js";
function git(args, cwd) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0)
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}
function makeRepo() {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-shadow-test-"));
    git(["init", "-q"], dir);
    git(["config", "user.email", "test@example.com"], dir);
    git(["config", "user.name", "Test"], dir);
    git(["config", "core.autocrlf", "false"], dir);
    writeFileSync(join(dir, "app.ts"), "export const value = 1;\n", "utf8");
    git(["add", "."], dir);
    git(["commit", "-m", "init"], dir);
    return dir;
}
test("createShadow isolates changes and applyShadowDiff lands them atomically", () => {
    const dir = makeRepo();
    try {
        const shadow = createShadow(dir);
        try {
            writeFileSync(join(shadow.dir, "app.ts"), "export const value = 2;\n", "utf8");
            assert.equal(readFileSync(join(dir, "app.ts"), "utf8"), "export const value = 1;\n");
            const diff = shadowDiff(shadow.dir);
            assert.match(diff, /diff --git a\/app\.ts b\/app\.ts/);
            const applied = applyShadowDiff(dir, diff);
            assert.equal(applied.ok, true);
            assert.equal(applied.files, 1);
            assert.equal(readFileSync(join(dir, "app.ts"), "utf8"), "export const value = 2;\n");
        }
        finally {
            shadow.cleanup();
        }
        assert.equal(existsSync(join(dir, ".oc-pilot", "shadow-tree")), false);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("stripShadowArgs removes tree-specific flags", () => {
    assert.deepEqual(stripShadowArgs(["fix", "--apply", "--shadow", "--staged", "--diff", "x.diff", "--cwd", "shadow", "--rounds", "2"]), ["fix", "--apply", "--rounds", "2"]);
});
//# sourceMappingURL=shadow.test.js.map