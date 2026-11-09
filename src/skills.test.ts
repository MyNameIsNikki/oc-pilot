import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = join(repoRoot, "skills");

interface Skill {
  dir: string;
  name: string;
  description: string;
  body: string;
}

function loadSkills(): Skill[] {
  const dirs = readdirSync(skillsDir).filter((entry) =>
    statSync(join(skillsDir, entry)).isDirectory(),
  );
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
    assert.equal(
      skill.name,
      skill.dir,
      `${skill.dir}: name must match the directory`,
    );
    assert.ok(
      skill.description.length >= 40 && skill.description.length <= 600,
      `${skill.dir}: description must stay between 40 and 600 characters so hosts can route on it`,
    );
    assert.ok(
      /oc-pilot/.test(skill.body),
      `${skill.dir}: body must reference the oc-pilot CLI`,
    );
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
    "zoom-symbol",
    "invariants",
    "fuzz",
    "bankruptcy",
    "query",
    "sandbox",
    "hivemind",
    "honeypot",
    "alien-dna",
    "hyper-chamber",
    "butterfly",
    "blindfold",
    "antibody",
    "polygraph",
    "passport",
    "oracle",
    "vaccine",
    "mitosis",
    "intent",
    "scalpel",
    "mayday",
    "clairvoyant",
    "skeptic",
    "apoptosis",
    "injection",
    "contract-drift",
    "anti-regression",
    "boundaries",
    "test-plan",
    "compliance",
    "brag",
    "battle",
    "cleanup",
    "arch-diff",
    "roast",
    "cinema",
    "bounty",
    "autopsy",
    "echo",
  ]);
  for (const skill of skills) {
    for (const match of skill.body.matchAll(/oc-pilot ([a-z][a-z-]*)/g)) {
      const command = match[1];
      assert.ok(
        commands.has(command),
        `${skill.dir}: unknown command "${command}"`,
      );
    }
    assert.ok(!/TODO|TBD|FIXME/.test(skill.body), `${skill.dir}: placeholder left`);
    assert.ok(
      !/\r/.test(skill.body),
      `${skill.dir}: body must use LF line endings`,
    );
  }
});

test("skills use only documented flags", () => {
  const flags = new Set([
    "--agent",
    "--allow-secrets",
    "--allow-unsafe-exec",
    "--allow-write",
    "--api-key-env",
    "--apply",
    "--audit",
    "--base",
    "--base-url",
    "--baseline",
    "--bad",
    "--branch",
    "--bug",
    "--case-timeout",
    "--clear",
    "--command",
    "--commit",
    "--config",
    "--confirm",
    "--context",
    "--coverage-file",
    "--criteria",
    "--criteria-text",
    "--cwd",
    "--depth",
    "--cast",
    "--check",
    "--file",
    "--diff",
    "--dry-run",
    "--duration",
    "--engine",
    "--endpoint",
    "--error",
    "--exclude",
    "--explain",
    "--exit-code",
    "--fail-on",
    "--fail-on-crash",
    "--fail-on-issue",
    "--fail-on-flaky",
    "--fail-on-leak",
    "--fail-on-drift",
    "--fail-on-empty",
    "--fail-on-regression",
    "--fail-on-risk",
    "--fail-on-removed",
    "--max-edges",
    "--fail-on-task",
    "--fail-on-violation",
    "--fail-on-weakening",
    "--fail-on-uncovered",
    "--fail-on-missing",
    "--fail-on-secrets",
    "--fail-on-senescent",
    "--fail-under",
    "--fix",
    "--force",
    "--format",
    "--good",
    "--host",
    "--history",
    "--github",
    "--hologram",
    "--include-untracked",
    "--input",
    "--interactive",
    "--json",
    "--keep-on-test-failure",
    "--lang",
    "--limit",
    "--log",
    "--list",
    "--max-diff",
    "--max-cases",
    "--max-file",
    "--max-files",
    "--max-steps",
    "--max-frames",
    "--max-mutants",
    "--max-targets",
    "--max-tokens",
    "--memory-limit",
    "--max-uncovered",
    "--min-age-days",
    "--min-downloads",
    "--min-score",
    "--model",
    "--name",
    "--no-cache",
    "--no-diff",
    "--no-paths",
    "--no-repo-context",
    "--no-secret-scan",
    "--no-snapshot",
    "--no-test",
    "--no-tests",
    "--online",
    "--output",
    "--payload",
    "--port",
    "--persona",
    "--preset",
    "--pre-push",
    "--prune",
    "--require-tests",
    "--rounds",
    "--runs",
    "--rules",
    "--request",
    "--request-file",
    "--budget",
    "--test-log",
    "--test-command",
    "--test-timeout",
    "--second-opinion",
    "--second-opinion-api-key-env",
    "--second-opinion-base-url",
    "--second-opinion-model",
    "--since",
    "--since-days",
    "--staged",
    "--stats",
    "--svg",
    "--stdin",
    "--strict",
    "--strategy",
    "--shadow",
    "--submit",
    "--timeout",
    "--to",
    "--type",
    "--uninstall",
    "--unstaged",
    "--update-baseline",
    "--verbose",
    "--verify",
    "--version",
  ]);
  for (const skill of skills) {
    for (const line of skill.body.split("\n")) {
      if (!line.includes("oc-pilot")) continue;
      for (const match of line.matchAll(/(?<![\w-])(--[a-z][a-z-]*)/g)) {
        const flag = match[1];
        assert.ok(flags.has(flag), `${skill.dir}: unknown flag "${flag}"`);
      }
    }
  }
});
