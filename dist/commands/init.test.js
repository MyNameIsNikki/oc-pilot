import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInit } from "./init.js";
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
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("init --json reports both created paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-init-json-"));
    try {
        const code = runInit(["--cwd", dir, "--preset", "node", "--json"]);
        assert.equal(code, 0);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("an unknown preset is a usage error listing the options", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-init-unknown-"));
    try {
        assert.throws(() => runInit(["--cwd", dir, "--preset", "cobol"]), (error) => {
            assert.ok(error instanceof PilotError);
            assert.match(error.message, /Неизвестный пресет: cobol/);
            assert.match(error.hint ?? "", /base, node, react, python, go/);
            assert.equal(error.exitCode, 2);
            return true;
        });
        assert.ok(!existsSync(join(dir, ".oc-pilot.json")));
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("an existing rules.md requires --force", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-init-exists-"));
    try {
        assert.equal(runInit(["--cwd", dir, "--preset", "base"]), 0);
        assert.throws(() => runInit(["--cwd", dir, "--preset", "base"]), (error) => {
            assert.ok(error instanceof PilotError);
            assert.match(error.message, /Файл правил уже существует/);
            return true;
        });
        assert.equal(runInit(["--cwd", dir, "--preset", "go", "--force"]), 0);
        assert.ok(readFileSync(join(dir, ".oc-pilot", "rules.md"), "utf8").includes("%w"));
    }
    finally {
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
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=init.test.js.map