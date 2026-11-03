import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILTIN_AGENT, buildAgentDefinition, buildConfigContent, quoteShellArg } from "./opencode.js";
function rulesFor(definition) {
    return definition.permissions.map((rule) => `${rule.effect}:${rule.action}:${rule.resource}`);
}
test("repo-context agent allows only read, glob and grep", () => {
    const definition = buildAgentDefinition("SYSTEM", true);
    const rules = rulesFor(definition);
    assert.equal(definition.steps, 8);
    assert.ok(rules.includes("allow:read:*"));
    assert.ok(rules.includes("allow:glob:*"));
    assert.ok(rules.includes("allow:grep:*"));
    assert.ok(!rules.includes("allow:edit:*"));
    assert.ok(!rules.includes("allow:shell:*"));
    assert.ok(rules.includes("deny:external_directory:*"));
    assert.ok(rules.indexOf("deny:read:*.env") > rules.indexOf("allow:read:*"));
    assert.ok(rules.indexOf("allow:read:*.env.example") > rules.indexOf("deny:read:*.env.*"));
});
test("quoteShellArg escapes backslashes before quotes and at the end", () => {
    assert.equal(quoteShellArg("plain-arg"), "plain-arg");
    assert.equal(quoteShellArg("C:\\tmp\\file.txt"), "C:\\tmp\\file.txt");
    assert.equal(quoteShellArg("with space"), '"with space"');
    assert.equal(quoteShellArg('say "hi"'), '"say \\"hi\\""');
    assert.equal(quoteShellArg('back\\slash "quoted"'), '"back\\slash \\"quoted\\""');
    assert.equal(quoteShellArg("trailing\\"), '"trailing\\\\"');
    assert.equal(quoteShellArg('already \\"escaped\\"'), '"already \\\\\\"escaped\\\\\\""');
});
test("diff-only agent denies every tool", () => {
    const definition = buildAgentDefinition("SYSTEM", false);
    assert.equal(definition.steps, 2);
    assert.deepEqual(definition.permissions, [{ action: "*", resource: "*", effect: "deny" }]);
});
test("buildConfigContent preserves existing inline config", () => {
    const saved = process.env.OPENCODE_CONFIG_CONTENT;
    try {
        process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
            model: "provider/model",
            agents: { reviewer: { description: "existing" } },
        });
        const parsed = JSON.parse(buildConfigContent("SYSTEM", true));
        assert.equal(parsed.model, "provider/model");
        assert.equal(parsed.agents.reviewer?.description, "existing");
        assert.equal(parsed.agents[BUILTIN_AGENT]?.system, "SYSTEM");
        assert.equal(parsed.agents[BUILTIN_AGENT]?.steps, 8);
    }
    finally {
        if (saved === undefined)
            delete process.env.OPENCODE_CONFIG_CONTENT;
        else
            process.env.OPENCODE_CONFIG_CONTENT = saved;
    }
});
test("buildConfigContent tolerates invalid existing JSON", () => {
    const saved = process.env.OPENCODE_CONFIG_CONTENT;
    try {
        process.env.OPENCODE_CONFIG_CONTENT = "{ invalid";
        const parsed = JSON.parse(buildConfigContent("SYSTEM", false));
        assert.equal(parsed.agents[BUILTIN_AGENT]?.system, "SYSTEM");
    }
    finally {
        if (saved === undefined)
            delete process.env.OPENCODE_CONFIG_CONTENT;
        else
            process.env.OPENCODE_CONFIG_CONTENT = saved;
    }
});
//# sourceMappingURL=opencode.test.js.map