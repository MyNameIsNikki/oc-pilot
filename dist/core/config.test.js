import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, loadConfig } from "./config.js";
const ENV_KEYS = [
    "OC_PILOT_MODEL",
    "OC_PILOT_AGENT",
    "OC_PILOT_MAX_DIFF_CHARS",
    "OC_PILOT_MAX_OUTPUT_CHARS",
    "OC_PILOT_TIMEOUT_SECONDS",
    "OC_PILOT_TEST_COMMAND",
    "OC_PILOT_REDACT_SECRETS",
    "OC_PILOT_MAX_FILE_CHARS",
    "OC_PILOT_REPO_CONTEXT",
    "OC_PILOT_FAIL_ON",
    "OC_PILOT_RULES",
    "OC_PILOT_ROUTER",
    "OC_PILOT_ROUTER_MODEL",
];
function withCleanEnv() {
    const saved = new Map();
    for (const key of ENV_KEYS) {
        saved.set(key, process.env[key]);
        delete process.env[key];
    }
    return () => {
        for (const key of ENV_KEYS) {
            const value = saved.get(key);
            if (value === undefined)
                delete process.env[key];
            else
                process.env[key] = value;
        }
    };
}
test("loadConfig finds .oc-pilot.json in a parent directory", () => {
    const restore = withCleanEnv();
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-config-"));
    try {
        writeFileSync(join(dir, ".oc-pilot.json"), JSON.stringify({ agent: "reviewer", maxDiffChars: 5_000, testCommand: "go test ./..." }));
        const nested = join(dir, "src", "nested");
        mkdirSync(nested, { recursive: true });
        const loaded = loadConfig({ cwd: nested });
        assert.equal(loaded.path, join(dir, ".oc-pilot.json"));
        assert.equal(loaded.config.agent, "reviewer");
        assert.equal(loaded.config.maxDiffChars, 5_000);
        assert.equal(loaded.config.testCommand, "go test ./...");
        assert.equal(loaded.config.maxOutputChars, DEFAULT_CONFIG.maxOutputChars);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
        restore();
    }
});
test("CLI overrides and env override the config file", () => {
    const restore = withCleanEnv();
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-config-"));
    try {
        writeFileSync(join(dir, ".oc-pilot.json"), JSON.stringify({ model: "file/model", agent: "file-agent" }));
        process.env.OC_PILOT_MODEL = "env/model";
        const loaded = loadConfig({
            cwd: dir,
            overrides: { agent: "cli-agent", maxDiffChars: 42_000 },
        });
        assert.equal(loaded.config.model, "env/model");
        assert.equal(loaded.config.agent, "cli-agent");
        assert.equal(loaded.config.maxDiffChars, 42_000);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
        restore();
    }
});
test("loadConfig rejects invalid JSON and missing explicit configs", () => {
    const restore = withCleanEnv();
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-config-"));
    try {
        writeFileSync(join(dir, ".oc-pilot.json"), "{ nope");
        assert.throws(() => loadConfig({ cwd: dir }), /Некорректный JSON/);
        assert.throws(() => loadConfig({ cwd: dir, explicitPath: "missing.json" }), /Конфиг не найден/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
        restore();
    }
});
test("configTemplate uses the built-in agent", async () => {
    const { configTemplate } = await import("./config.js");
    const template = configTemplate();
    assert.match(template, /"agent": "oc-pilot"/);
    assert.match(template, /"repoContext": true/);
    assert.match(template, /"failOn": "none"/);
});
test("loadConfig reads repoContext, failOn and rules", () => {
    const restore = withCleanEnv();
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-config-"));
    try {
        writeFileSync(join(dir, ".oc-pilot.json"), JSON.stringify({ repoContext: false, failOn: "warning", rules: ".oc-pilot/review.md" }));
        const loaded = loadConfig({ cwd: dir });
        assert.equal(loaded.config.repoContext, false);
        assert.equal(loaded.config.failOn, "warning");
        assert.equal(loaded.config.rules, ".oc-pilot/review.md");
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
        restore();
    }
});
test("env and CLI override repoContext, failOn and rules", () => {
    const restore = withCleanEnv();
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-config-"));
    try {
        process.env.OC_PILOT_REPO_CONTEXT = "false";
        process.env.OC_PILOT_FAIL_ON = "critical";
        process.env.OC_PILOT_RULES = "env-rules.md";
        writeFileSync(join(dir, ".oc-pilot.json"), JSON.stringify({ repoContext: true, failOn: "none" }));
        const loaded = loadConfig({
            cwd: dir,
            overrides: { repoContext: true, failOn: "style", rules: "cli-rules.md" },
        });
        assert.equal(loaded.config.repoContext, true);
        assert.equal(loaded.config.failOn, "style");
        assert.equal(loaded.config.rules, "cli-rules.md");
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
        restore();
    }
});
test("loadConfig rejects invalid failOn", () => {
    const restore = withCleanEnv();
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-config-"));
    try {
        writeFileSync(join(dir, ".oc-pilot.json"), JSON.stringify({ failOn: "fatal" }));
        assert.throws(() => loadConfig({ cwd: dir }), /Некорректное значение failOn/);
        writeFileSync(join(dir, ".oc-pilot.json"), "{}");
        process.env.OC_PILOT_FAIL_ON = "fatal";
        assert.throws(() => loadConfig({ cwd: dir }), /Некорректное значение OC_PILOT_FAIL_ON/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
        restore();
    }
});
test("router settings load from file and env", () => {
    const restore = withCleanEnv();
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-config-"));
    try {
        writeFileSync(join(dir, ".oc-pilot.json"), JSON.stringify({ routerEnabled: true, routerModel: "fast-model" }));
        let loaded = loadConfig({ cwd: dir });
        assert.equal(loaded.config.routerEnabled, true);
        assert.equal(loaded.config.routerModel, "fast-model");
        process.env.OC_PILOT_ROUTER_MODEL = "env-model";
        loaded = loadConfig({ cwd: dir });
        assert.equal(loaded.config.routerModel, "env-model");
        process.env.OC_PILOT_ROUTER = "false";
        loaded = loadConfig({ cwd: dir });
        assert.equal(loaded.config.routerEnabled, false);
        process.env.OC_PILOT_ROUTER = "maybe";
        assert.throws(() => loadConfig({ cwd: dir }), /OC_PILOT_ROUTER/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
        restore();
    }
});
//# sourceMappingURL=config.test.js.map