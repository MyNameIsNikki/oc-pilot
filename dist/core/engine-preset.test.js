import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ENGINE_PRESETS, findEnginePreset, parseEnginePreset, presetIds } from "./engine.js";
import { resolveContext } from "./options.js";
function emptyDir() {
    return mkdtempSync(join(tmpdir(), "oc-pilot-preset-"));
}
test("engine presets cover ollama, lmstudio and openrouter", () => {
    assert.deepEqual(presetIds(), ["ollama", "lmstudio", "openrouter"]);
    for (const preset of ENGINE_PRESETS) {
        assert.ok(preset.baseUrl.startsWith("http"), preset.id);
        assert.ok(preset.apiKeyEnv.length > 0, preset.id);
        assert.ok(preset.note.length > 0, preset.id);
    }
    assert.equal(findEnginePreset("OLLAMA")?.id, "ollama");
    assert.equal(findEnginePreset("unknown"), undefined);
});
test("parseEnginePreset rejects unknown ids with a hint", () => {
    assert.throws(() => parseEnginePreset("bedrock"), (error) => {
        const typed = error;
        assert.match(typed.message, /bedrock/);
        assert.match(typed.hint ?? "", /ollama, lmstudio, openrouter/);
        assert.equal(typed.exitCode, 2);
        return true;
    });
});
test("--engine-preset fills engine, base URL and key env", () => {
    const cwd = emptyDir();
    try {
        const context = resolveContext({ cwd, "engine-preset": "lmstudio" });
        assert.equal(context.config.engine, "openai");
        assert.equal(context.config.baseUrl, "http://localhost:1234/v1");
        assert.equal(context.config.apiKeyEnv, "LMSTUDIO_API_KEY");
    }
    finally {
        rmSync(cwd, { recursive: true, force: true });
    }
});
test("ollama preset sets a default model and explicit flags win", () => {
    const cwd = emptyDir();
    try {
        const preset = resolveContext({ cwd, "engine-preset": "ollama" });
        assert.equal(preset.config.model, "llama3.2");
        const explicit = resolveContext({
            cwd,
            "engine-preset": "ollama",
            "base-url": "http://127.0.0.1:9999/v1",
            model: "qwen2.5-coder",
        });
        assert.equal(explicit.config.baseUrl, "http://127.0.0.1:9999/v1");
        assert.equal(explicit.config.model, "qwen2.5-coder");
    }
    finally {
        rmSync(cwd, { recursive: true, force: true });
    }
});
//# sourceMappingURL=engine-preset.test.js.map