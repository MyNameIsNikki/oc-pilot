import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { runDoctor, versionInvocation } from "./doctor.js";
import { cacheKey, cacheRoot, cacheStats } from "../core/cache.js";
import { HOOK_MARKER } from "./install-hook.js";
import { VERSION } from "../version.js";
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
function addLocalBinary(dir, version) {
    const binDir = join(dir, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    if (process.platform === "win32") {
        writeFileSync(join(binDir, "oc-pilot.cmd"), `@echo oc-pilot ${version}\r\n`, "utf8");
        return;
    }
    const bin = join(binDir, "oc-pilot");
    writeFileSync(bin, `#!/bin/sh\necho "oc-pilot ${version}"\n`, "utf8");
    chmodSync(bin, 0o755);
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
test("doctor warns when an installed managed hook cannot resolve oc-pilot", async () => {
    const dir = makeRepo("oc-pilot-doctor-hook-binary-");
    try {
        const hookPath = join(hooksDir(dir), "pre-commit");
        writeFileSync(hookPath, "#!/bin/sh\n# oc-pilot hook v2\noc-pilot preflight --staged\n", "utf8");
        const previous = process.env.OC_PILOT_BIN;
        process.env.OC_PILOT_BIN = join(dir, "missing-oc-pilot");
        const original = process.stdout.write;
        let output = "";
        process.stdout.write = ((chunk) => {
            output += chunk.toString();
            return true;
        });
        try {
            const code = await runDoctor(doctorArgs(dir, ["--json"]));
            assert.equal(code, 0);
        }
        finally {
            process.stdout.write = original;
            if (previous === undefined)
                delete process.env.OC_PILOT_BIN;
            else
                process.env.OC_PILOT_BIN = previous;
        }
        const report = JSON.parse(output);
        const warning = report.checks.find((check) => check.title === "oc-pilot binary not found for the installed hooks");
        assert.ok(warning);
        assert.equal(warning.status, "warn");
        assert.match(warning.detail ?? "", /OC_PILOT_BIN/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("doctor warns when the managed hook uses another oc-pilot version", async () => {
    const dir = makeRepo("oc-pilot-doctor-hook-version-");
    try {
        const hookPath = join(hooksDir(dir), "pre-commit");
        writeFileSync(hookPath, "#!/bin/sh\n# oc-pilot hook v2\noc-pilot preflight --staged\n", "utf8");
        addLocalBinary(dir, "0.0.1");
        const original = process.stdout.write;
        let output = "";
        process.stdout.write = ((chunk) => {
            output += chunk.toString();
            return true;
        });
        try {
            const code = await runDoctor(doctorArgs(dir, ["--json"]));
            assert.equal(code, 0);
        }
        finally {
            process.stdout.write = original;
        }
        const report = JSON.parse(output);
        const warning = report.checks.find((check) => check.title.includes(`hook uses oc-pilot 0.0.1, current is ${VERSION}`));
        assert.ok(warning);
        assert.equal(warning.status, "warn");
        assert.match(warning.detail ?? "", /0\.0\.1/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("versionInvocation runs plain commands without a shell", () => {
    const invocation = versionInvocation("git");
    assert.equal(invocation.file, "git");
    assert.deepEqual(invocation.args, ["--version"]);
    assert.equal(invocation.windowsVerbatimArguments, undefined);
});
test("versionInvocation routes Windows command shims through cmd.exe", () => {
    if (process.platform !== "win32")
        return;
    const invocation = versionInvocation("C:\\tools\\opencode.cmd");
    assert.equal(invocation.file, process.env.ComSpec ?? "cmd.exe");
    assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.equal(invocation.args[3], '"C:\\tools\\opencode.cmd" --version');
    assert.equal(invocation.windowsVerbatimArguments, true);
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