import assert from "node:assert/strict";
import { test } from "node:test";
import { getPreset, presetIds, PRESETS } from "./presets.js";
test("five presets are registered with stable ids", () => {
    assert.deepEqual(presetIds(), ["base", "node", "react", "python", "go"]);
});
test("every preset ships non-empty markdown rules", () => {
    for (const preset of PRESETS) {
        assert.ok(preset.rules.length > 200, `${preset.id} rules look too short`);
        assert.ok(preset.rules.startsWith("# Project review rules"), `${preset.id} must start with the common header`);
        assert.ok(preset.description.length > 0, `${preset.id} needs a description`);
    }
});
test("presets carry stack-specific guidance", () => {
    assert.ok(getPreset("base").rules.includes("race conditions"));
    assert.ok(getPreset("node").rules.includes("floating promises"));
    assert.ok(getPreset("react").rules.includes("## Hooks"));
    assert.ok(getPreset("python").rules.includes("dataclasses"));
    assert.ok(getPreset("go").rules.includes("%w"));
});
test("getPreset returns undefined for unknown ids", () => {
    assert.equal(getPreset("cobol"), undefined);
});
//# sourceMappingURL=presets.test.js.map