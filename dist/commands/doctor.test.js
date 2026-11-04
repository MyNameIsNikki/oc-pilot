import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { runDoctor } from "./doctor.js";
import { cacheKey, cacheRoot, cacheStats } from "../core/cache.js";
import { HOOK_MARKER } from "./install-hook.js";
function makeRepo(prefix) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    execSync("git init", { cwd: dir, stdio: "ignore" });
    execSync("git config user.email test@example.com", { cwd: dir, stdio: "ignore" });
    execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, "a.txt"), "one\n");
    execSync("git add -A", { cwd: dir, stdio: "ignore" });
    execSync("git commit -m init", { cwd: dir, stdio: "ignore" });
    return dir;
}
function hooksDir(dir) {
    const raw = execSync("git rev-parse --git-path hooks", { cwd: dir }).toString().trim();
    return isAbsolute(raw) ? raw : resolvePath(dir, raw);
}
function doctorArgs(dir, extra = []) {
    return [
        "--cwd", dir,
        "--engine", "openai",
        "--model", "test-model",
        "--base-url", "http://localhost:9/v1",
        ...extra,
    ];
}
test("doctor --fix refreshes an outdated oc-pilot hook", async () => {
    const dir = makeRepo("oc-pilot-doctor-hooks-");
    try {
        const hookPath = join(hooksDir(dir), "pre-commit");
        writeFileSync(hookPath, "#!/bin/sh\n# oc-pilot hook v0\nexec oc-pilot scan --staged\n", "utf8");
        const code = await runDoctor(doctorArgs(dir));
        assert.equal(code, 0);
        assert.ok(readFileSync(hookPath, "utf8").includes("# oc-pilot hook v0"), "no fix without --fix");
        const fixed = await runDoctor(doctorArgs(dir, ["--fix"]));
        assert.equal(fixed, 0);
        const content = readFileSync(hookPath, "utf8");
        assert.ok(content.includes(HOOK_MARKER));
        assert.ok(content.includes("preflight --staged"));
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("doctor keeps foreign hooks alone and prunes expired cache with --fix", async () => {
    const dir = makeRepo("oc-pilot-doctor-cache-");
    try {
        const hookPath = join(hooksDir(dir), "pre-commit");
        writeFileSync(hookPath, "#!/bin/sh\nexec husky\n", "utf8");
        const root = cacheRoot(dir);
        mkdirSync(root, { recursive: true });
        const staleKey = cacheKey({ systemPrompt: "s", input: "stale", model: "m" });
        writeFileSync(join(root, `${staleKey}.json`), JSON.stringify({ version: 1, createdAt: 0, expiresAt: 1, text: "old" }), "utf8");
        const code = await runDoctor(doctorArgs(dir, ["--fix"]));
        assert.equal(code, 0);
        assert.equal(readFileSync(hookPath, "utf8"), "#!/bin/sh\nexec husky\n", "foreign hooks must stay");
        assert.equal(cacheStats(dir)?.entries ?? 0, 0, "expired entries must be pruned");
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=doctor.test.js.map