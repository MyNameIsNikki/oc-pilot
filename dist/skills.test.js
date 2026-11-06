import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = join(repoRoot, "skills");
function loadSkills() {
    const dirs = readdirSync(skillsDir).filter((entry) => statSync(join(skillsDir, entry)).isDirectory());
    return dirs.map((dir) => {
        const text = readFileSync(join(skillsDir, dir, "SKILL.md"), "utf8");
        const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
        assert.ok(match, `${dir}/SKILL.md must start with YAML front matter`);
        const [, front, body] = match;
        const name = /^name:\s*(.+)$/m.exec(front)?.[1]?.trim();
        const description = /^description:\s*(.+)$/m.exec(front)?.[1]?.trim();
        assert.ok(name, `${dir}/SKILL.md is missing a name`);
        assert.ok(description, `${dir}/SKILL.md is missing a description`);
        return { dir, name, description, body };
    });
}
const skills = loadSkills();
test("every skill directory has a valid SKILL.md", () => {
    assert.ok(skills.length >= 6, "expected the core skills to be present");
    for (const skill of skills) {
        assert.equal(skill.name, skill.dir, `${skill.dir}: name must match the directory`);
        assert.ok(skill.description.length >= 40 && skill.description.length <= 600, `${skill.dir}: description must stay between 40 and 600 characters so hosts can route on it`);
        assert.ok(/oc-pilot/.test(skill.body), `${skill.dir}: body must reference the oc-pilot CLI`);
    }
});
test("skills document real commands and avoid placeholders", () => {
    const commands = new Set([
        "review",
        "test-fix",
        "test-gen",
        "fix",
        "scan",
        "commit",
        "docgen",
        "custom",
        "init",
        "install-hook",
        "restore",
        "cache",
        "stats",
        "day",
        "doctor",
        "setup",
        "mcp",
        "version",
        "help",
        "mutate",
        "flaky",
        "impact",
        "deps",
        "coverage",
        "reviewers",
        "test-guard",
        "env-sync",
        "mock-leak",
        "ecosystem-verify",
        "pack",
        "contract-drift",
        "anti-regression",
        "boundaries",
        "test-plan",
        "compliance",
        "brag",
        "battle",
        "cleanup",
        "arch-diff",
    ]);
    for (const skill of skills) {
        for (const match of skill.body.matchAll(/oc-pilot ([a-z][a-z-]*)/g)) {
            const command = match[1];
            assert.ok(commands.has(command), `${skill.dir}: unknown command "${command}"`);
        }
        assert.ok(!/TODO|TBD|FIXME/.test(skill.body), `${skill.dir}: placeholder left`);
        assert.ok(!/\r/.test(skill.body), `${skill.dir}: body must use LF line endings`);
    }
});
test("skills use only documented flags", () => {
    const flags = new Set([
        "--agent",
        "--allow-secrets",
        "--api-key-env",
        "--apply",
        "--audit",
        "--base",
        "--base-url",
        "--baseline",
        "--clear",
        "--command",
        "--config",
        "--context",
        "--coverage-file",
        "--cwd",
        "--depth",
        "--check",
        "--diff",
        "--dry-run",
        "--engine",
        "--exclude",
        "--exit-code",
        "--fail-on",
        "--fail-on-issue",
        "--fail-on-flaky",
        "--fail-on-leak",
        "--fail-on-drift",
        "--fail-on-regression",
        "--fail-on-removed",
        "--max-edges",
        "--fail-on-task",
        "--fail-on-violation",
        "--fail-on-weakening",
        "--fail-on-uncovered",
        "--fail-on-missing",
        "--fail-on-secrets",
        "--fail-under",
        "--fix",
        "--force",
        "--format",
        "--github",
        "--include-untracked",
        "--interactive",
        "--json",
        "--keep-on-test-failure",
        "--lang",
        "--limit",
        "--log",
        "--list",
        "--max-diff",
        "--max-file",
        "--max-mutants",
        "--max-uncovered",
        "--min-age-days",
        "--min-downloads",
        "--min-score",
        "--model",
        "--no-cache",
        "--no-diff",
        "--no-repo-context",
        "--no-secret-scan",
        "--no-snapshot",
        "--no-tests",
        "--online",
        "--output",
        "--preset",
        "--pre-push",
        "--prune",
        "--require-tests",
        "--rounds",
        "--runs",
        "--rules",
        "--budget",
        "--test-log",
        "--second-opinion",
        "--second-opinion-api-key-env",
        "--second-opinion-base-url",
        "--second-opinion-model",
        "--since",
        "--since-days",
        "--staged",
        "--stats",
        "--stdin",
        "--strict",
        "--timeout",
        "--uninstall",
        "--unstaged",
        "--update-baseline",
        "--verbose",
        "--verify",
        "--version",
    ]);
    for (const skill of skills) {
        for (const line of skill.body.split("\n")) {
            if (!line.includes("oc-pilot"))
                continue;
            for (const match of line.matchAll(/(?<![\w-])(--[a-z][a-z-]*)/g)) {
                const flag = match[1];
                assert.ok(flags.has(flag), `${skill.dir}: unknown flag "${flag}"`);
            }
        }
    }
});
//# sourceMappingURL=skills.test.js.map