import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { assessReadiness } from "./readiness.js";
import { applyReadinessFixes, planReadinessFixes } from "./readiness-fix.js";
const MANIFEST = JSON.stringify({
    name: "demo",
    private: true,
    scripts: { test: 'node -e "process.exit(0)"' },
});
function makeRepo(files) {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-readiness-fix-"));
    spawnSync("git", ["init", "-q"], { cwd: dir });
    for (const [path, content] of Object.entries(files)) {
        const full = join(dir, path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content, "utf8");
    }
    return dir;
}
test("planReadinessFixes offers the safe fixes for a bare repository", () => {
    const dir = makeRepo({ "package.json": MANIFEST });
    try {
        const report = assessReadiness(dir);
        const plan = planReadinessFixes(dir, report);
        const actions = plan.fixes.map((fix) => fix.action).sort();
        assert.deepEqual(actions, ["install-hook", "write-agents", "write-config"]);
        const skipped = plan.skipped.map((skip) => skip.check);
        assert.ok(skipped.includes("lockfile"));
        assert.ok(skipped.includes("receipt"));
        assert.ok(skipped.includes("ci"));
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("applyReadinessFixes creates the hook, config and agent instructions", () => {
    const dir = makeRepo({ "package.json": MANIFEST });
    try {
        const before = assessReadiness(dir);
        const plan = planReadinessFixes(dir, before);
        const applied = applyReadinessFixes(dir, plan);
        assert.equal(applied.length, 3);
        const hook = readFileSync(join(dir, ".git", "hooks", "pre-commit"), "utf8");
        assert.match(hook, /# oc-pilot hook/);
        assert.match(hook, /preflight --staged/);
        const config = JSON.parse(readFileSync(join(dir, ".oc-pilot.json"), "utf8"));
        assert.equal(config.testCommand, "npm test");
        const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
        assert.match(agents, /npm test/);
        assert.match(agents, /oc-pilot preflight --staged/);
        const after = assessReadiness(dir);
        assert.ok(after.score > before.score);
        const status = new Map(after.checks.map((check) => [check.id, check.status]));
        assert.equal(status.get("hooks"), "pass");
        assert.equal(status.get("docs"), "pass");
        assert.equal(status.get("config"), "pass");
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("planReadinessFixes does not overwrite a foreign hook", () => {
    const dir = makeRepo({
        "package.json": MANIFEST,
        ".git/hooks/pre-commit": "#!/bin/sh\necho custom\n",
    });
    try {
        const report = assessReadiness(dir);
        const plan = planReadinessFixes(dir, report);
        assert.equal(plan.fixes.some((fix) => fix.action === "install-hook"), false);
        const hookSkip = plan.skipped.find((skip) => skip.check === "hooks");
        assert.match(hookSkip?.reason ?? "", /чужой/);
        assert.equal(readFileSync(join(dir, ".git", "hooks", "pre-commit"), "utf8"), "#!/bin/sh\necho custom\n");
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("planReadinessFixes keeps existing config and instructions", () => {
    const dir = makeRepo({
        "package.json": MANIFEST,
        ".oc-pilot.json": "{}\n",
        "AGENTS.md": "# AGENTS.md\n",
    });
    try {
        const plan = planReadinessFixes(dir, assessReadiness(dir));
        assert.equal(plan.fixes.some((fix) => fix.action === "write-config"), false);
        assert.equal(plan.fixes.some((fix) => fix.action === "write-agents"), false);
        assert.deepEqual(plan.fixes.map((fix) => fix.action), ["install-hook"]);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=readiness-fix.test.js.map