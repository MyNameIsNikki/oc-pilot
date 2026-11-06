import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
const MCP = resolve("dist/mcp.js");
function runServer(dir, requests, args = []) {
    const input = `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`;
    const result = spawnSync(process.execPath, [MCP, "--cwd", dir, ...args], {
        input,
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 16 * 1024 * 1024,
    });
    return (result.stdout ?? "")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
}
function tempDir() {
    return mkdtempSync(join(tmpdir(), "oc-pilot-mcp-prompts-"));
}
test("MCP advertises prompts and renders them with arguments", () => {
    const dir = tempDir();
    try {
        const responses = runServer(dir, [
            { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
            { jsonrpc: "2.0", id: 2, method: "prompts/list" },
            {
                jsonrpc: "2.0",
                id: 3,
                method: "prompts/get",
                params: { name: "review-my-diff", arguments: { context: "wallet refactor" } },
            },
        ]);
        const init = responses[0]?.result;
        assert.ok(init.capabilities.prompts, "prompts capability is advertised");
        const list = responses[1]?.result;
        const names = list.prompts.map((prompt) => prompt.name);
        assert.deepEqual(names, [
            "review-my-diff",
            "fix-failing-tests",
            "pre-commit-gate",
            "secure-change",
            "slop-check",
            "preflight-before-commit",
            "get-ready",
            "fix-security",
            "stabilize-flaky",
            "check-impact",
            "triage-deps",
            "cover-changed-lines",
            "generate-tests",
            "pick-reviewers",
            "guard-tests",
            "sync-env",
            "remove-mocks",
            "verify-ecosystem",
            "pack-context",
            "check-contracts",
            "guard-regressions",
            "respect-boundaries",
            "plan-tests",
            "prove-compliance",
            "battle-hardening",
            "cleanup-plan",
            "show-arch-diff",
            "roast-my-code",
            "play-session",
            "wanted-poster",
            "autopsy-commit",
            "prove-tests",
            "prove-done",
        ]);
        for (const prompt of list.prompts) {
            assert.ok(prompt.description.length > 0);
        }
        const got = responses[2]?.result;
        assert.equal(got.messages.length, 1);
        assert.equal(got.messages[0]?.role, "user");
        const text = got.messages[0]?.content.text ?? "";
        assert.match(text, /review/i);
        assert.match(text, /wallet refactor/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("MCP exposes commit and stats tools and keeps writes opt-in", () => {
    const dir = tempDir();
    try {
        const responses = runServer(dir, [
            { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
            { jsonrpc: "2.0", id: 2, method: "tools/list" },
            {
                jsonrpc: "2.0",
                id: 3,
                method: "tools/call",
                params: { name: "stats", arguments: { clear: true } },
            },
            {
                jsonrpc: "2.0",
                id: 4,
                method: "tools/call",
                params: { name: "commit", arguments: { apply: true } },
            },
        ]);
        const list = responses[1]?.result;
        const byName = new Map(list.tools.map((tool) => [tool.name, tool]));
        assert.ok(byName.has("commit"));
        assert.ok(byName.has("stats"));
        assert.equal(byName.get("stats")?.annotations?.readOnlyHint, true);
        const stats = responses[2]?.result;
        assert.equal(stats.isError, true);
        assert.match(stats.content[0]?.text ?? "", /read-only/);
        const commit = responses[3]?.result;
        assert.equal(commit.isError, true);
        assert.match(commit.content[0]?.text ?? "", /read-only/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=mcp-prompts.test.js.map