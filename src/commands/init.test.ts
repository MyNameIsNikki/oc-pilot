import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInit } from "./init.js";
import { HOOK_MARKER } from "./install-hook.js";
import { runGit } from "../core/git.js";
import { PilotError } from "../core/errors.js";

test("init --preset writes rules.md next to the config", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-init-preset-"));
  try {
    const code = runInit(["--cwd", dir, "--preset", "react"]);
    assert.equal(code, 0);

    assert.ok(existsSync(join(dir, ".oc-pilot.json")));
    const rules = readFileSync(join(dir, ".oc-pilot", "rules.md"), "utf8");
    assert.ok(rules.includes("# Project review rules"));
    assert.ok(rules.includes("## Hooks"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init --hooks installs pre-commit and pre-push hooks", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-init-hooks-"));
  try {
    runGit(["init"], dir);
    assert.equal(runInit(["--cwd", dir, "--hooks"]), 0);
    const hooks = join(dir, ".git", "hooks");
    assert.ok(readFileSync(join(hooks, "pre-commit"), "utf8").includes(HOOK_MARKER));
    assert.match(readFileSync(join(hooks, "pre-commit"), "utf8"), /preflight --staged/);
    assert.ok(readFileSync(join(hooks, "pre-push"), "utf8").includes(HOOK_MARKER));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init --json reports both created paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-init-json-"));
  try {
    const code = runInit(["--cwd", dir, "--preset", "node", "--json"]);
    assert.equal(code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown preset is a usage error listing the options", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-init-unknown-"));
  try {
    assert.throws(
      () => runInit(["--cwd", dir, "--preset", "cobol"]),
      (error: unknown) => {
        assert.ok(error instanceof PilotError);
        assert.match(error.message, /Неизвестный пресет: cobol/);
        assert.match(error.hint ?? "", /base, node, react, next/);
        assert.match(error.hint ?? "", /security, devops/);
        assert.equal(error.exitCode, 2);
        return true;
      },
    );
    assert.ok(!existsSync(join(dir, ".oc-pilot.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an existing rules.md requires --force", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-init-exists-"));
  try {
    assert.equal(runInit(["--cwd", dir, "--preset", "base"]), 0);
    assert.throws(
      () => runInit(["--cwd", dir, "--preset", "base"]),
      (error: unknown) => {
        assert.ok(error instanceof PilotError);
        assert.match(error.message, /Файл правил уже существует/);
        return true;
      },
    );
    assert.equal(runInit(["--cwd", dir, "--preset", "go", "--force"]), 0);
    assert.ok(readFileSync(join(dir, ".oc-pilot", "rules.md"), "utf8").includes("%w"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a preset never overwrites an existing config without --force", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-init-config-"));
  try {
    writeFileSync(join(dir, ".oc-pilot.json"), '{ "engine": "openai" }\n', "utf8");
    const code = runInit(["--cwd", dir, "--preset", "python"]);
    assert.equal(code, 0);
    assert.equal(readFileSync(join(dir, ".oc-pilot.json"), "utf8"), '{ "engine": "openai" }\n');
    assert.ok(existsSync(join(dir, ".oc-pilot", "rules.md")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("comma-separated presets combine into one rules file", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-init-multi-"));
  try {
    const code = runInit(["--cwd", dir, "--preset", "react, security"]);
    assert.equal(code, 0);

    const rules = readFileSync(join(dir, ".oc-pilot", "rules.md"), "utf8");
    assert.equal(rules.split("# Project review rules").length - 1, 1);
    assert.ok(rules.includes("## Hooks"));
    assert.ok(rules.includes("constant-time"));
    assert.ok(rules.includes("\n---\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one unknown preset in a comma list fails the whole list", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-init-multi-unknown-"));
  try {
    assert.throws(
      () => runInit(["--cwd", dir, "--preset", "react,cobol"]),
      (error: unknown) => {
        assert.ok(error instanceof PilotError);
        assert.match(error.message, /Неизвестный пресет: cobol/);
        assert.equal(error.exitCode, 2);
        return true;
      },
    );
    assert.ok(!existsSync(join(dir, ".oc-pilot", "rules.md")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stack presets beyond the original five are accepted", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-init-newstack-"));
  try {
    for (const id of ["rust", "vue", "csharp", "devops"]) {
      assert.equal(runInit(["--cwd", dir, "--preset", id, "--force"]), 0, id);
      assert.ok(existsSync(join(dir, ".oc-pilot", "rules.md")), id);
    }
    const devops = readFileSync(join(dir, ".oc-pilot", "rules.md"), "utf8");
    assert.ok(devops.includes(":latest"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
