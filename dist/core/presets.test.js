import assert from "node:assert/strict";
import { test } from "node:test";
import { combinePresets, getPreset, presetIds, PRESETS } from "./presets.js";
test("all presets are registered with stable ids", () => {
    assert.deepEqual(presetIds(), [
        "base",
        "node",
        "react",
        "next",
        "vue",
        "svelte",
        "angular",
        "typescript",
        "python",
        "go",
        "rust",
        "java",
        "kotlin",
        "csharp",
        "swift",
        "php",
        "ruby",
        "security",
        "devops",
    ]);
});
test("every preset ships non-empty markdown rules", () => {
    for (const preset of PRESETS) {
        assert.ok(preset.rules.length > 200, `${preset.id} rules look too short`);
        assert.ok(preset.rules.startsWith("# Project review rules"), `${preset.id} must start with the common header`);
        assert.ok(preset.description.length > 0, `${preset.id} needs a description`);
    }
});
test("presets carry stack-specific guidance", () => {
    const markers = {
        base: "race conditions",
        node: "floating promises",
        react: "## Hooks",
        next: "use client",
        vue: "## Composition API",
        svelte: "$derived",
        angular: "takeUntilDestroyed",
        typescript: "discriminated unions",
        python: "dataclasses",
        go: "%w",
        rust: "unsafe",
        java: "try-with-resources",
        kotlin: "GlobalScope",
        csharp: "async void",
        swift: "retain cycles",
        php: "strict_types",
        ruby: "Strong params",
        security: "constant-time",
        devops: ":latest",
    };
    for (const [id, marker] of Object.entries(markers)) {
        assert.ok(getPreset(id).rules.includes(marker), `${id} must mention "${marker}"`);
    }
});
test("getPreset returns undefined for unknown ids", () => {
    assert.equal(getPreset("cobol"), undefined);
});
test("combinePresets merges bodies under a single header", () => {
    const combined = combinePresets([getPreset("react"), getPreset("security")]);
    assert.equal(combined.split("# Project review rules").length - 1, 1);
    assert.ok(combined.includes("## Hooks"));
    assert.ok(combined.includes("constant-time"));
    assert.ok(combined.includes("\n---\n"));
    assert.ok(combined.endsWith("\n"));
});
//# sourceMappingURL=presets.test.js.map