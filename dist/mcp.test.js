import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
const MCP = resolve("dist/mcp.js");
const AWS_KEY = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
function runServer(dir, requests, args = []) {
    const input = `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`;
    const result = spawnSync(process.execPath, [MCP, "--cwd", dir, ...args], {
        input,
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 16 * 1024 * 1024,
    });
    const responses = (result.stdout ?? "")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    return { status: result.status, responses, stderr: result.stderr ?? "" };
}
test("MCP initialize, tools/list and tools/call work over stdio", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-mcp-"));
    try {
        const diffPath = join(dir, "changes.diff");
        writeFileSync(diffPath, [
            "diff --git a/wallet.go b/wallet.go",
            "--- a/wallet.go",
            "+++ b/wallet.go",
            "@@ -1,1 +1,2 @@",
            " package wallet",
            `+const apiKey = "${AWS_KEY}"`,
            "",
        ].join("\n"));
        const { status, responses, stderr } = runServer(dir, [
            {
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
            },
            { jsonrpc: "2.0", method: "notifications/initialized" },
            { jsonrpc: "2.0", id: 2, method: "tools/list" },
            {
                jsonrpc: "2.0",
                id: 3,
                method: "tools/call",
                params: { name: "scan", arguments: { diff: readFileSync(diffPath, "utf8") } },
            },
            { jsonrpc: "2.0", id: 4, method: "does/not/exist" },
        ]);
        assert.equal(status, 0, stderr);
        const byId = new Map(responses.map((response) => [response.id, response]));
        const init = byId.get(1)?.result;
        assert.equal(init?.serverInfo?.name, "oc-pilot");
        assert.equal(init?.protocolVersion, "2025-06-18");
        const list = byId.get(2)?.result;
        const names = new Set(list?.tools?.map((tool) => tool.name));
        for (const name of ["review", "test_fix", "fix", "docgen", "custom", "scan"])
            assert.ok(names.has(name), name);
        const scan = byId.get(3)?.result;
        assert.equal(scan?.isError, false);
        assert.ok(scan?.structuredContent?.findings?.some((finding) => finding.kind === "AWS Access Key ID"));
        assert.ok(scan?.content?.some((part) => part.type === "text" && part.text.includes("AWS Access Key ID")));
        assert.ok(!(scan?.content?.[0]?.text ?? "").includes(AWS_KEY));
        assert.equal(byId.get(4)?.error?.code, -32601);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("MCP is read-only by default and rejects paths outside the project", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-mcp-policy-"));
    try {
        const { status, responses, stderr } = runServer(dir, [
            {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name: "review", arguments: { diff: "diff --git a/a b/a\n", paths: ["../outside"] } },
            },
            {
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: { name: "fix", arguments: { diff: "diff --git a/a b/a\n", apply: true } },
            },
            {
                jsonrpc: "2.0",
                id: 3,
                method: "tools/call",
                params: { name: "test_fix", arguments: { diff: "diff --git a/a b/a\n" } },
            },
        ], []);
        assert.equal(status, 0, stderr);
        const byId = new Map(responses.map((response) => [response.id, response]));
        const pathResult = byId.get(1)?.result;
        assert.equal(pathResult?.isError, true);
        assert.match(pathResult?.content?.[0]?.text ?? "", /inside the project/);
        const fixResult = byId.get(2)?.result;
        assert.equal(fixResult?.isError, true);
        assert.match(fixResult?.content?.[0]?.text ?? "", /read-only/);
        const testResult = byId.get(3)?.result;
        assert.equal(testResult?.isError, true);
        assert.match(testResult?.content?.[0]?.text ?? "", /read-only/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("MCP rejects malformed JSON without crashing", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-mcp-"));
    try {
        const result = spawnSync(process.execPath, [MCP, "--cwd", dir], {
            input: "{not json\n",
            encoding: "utf8",
            timeout: 30_000,
        });
        assert.equal(result.status, 0, result.stderr);
        const response = JSON.parse(result.stdout.trim());
        assert.equal(response.error?.code, -32700);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("MCP exposes resources and resource templates", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-mcp-res-"));
    try {
        const git = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
        git(["init"]);
        git(["config", "user.email", "test@example.com"]);
        git(["config", "user.name", "Test"]);
        git(["config", "core.autocrlf", "false"]);
        writeFileSync(join(dir, "a.txt"), "v1\n");
        writeFileSync(join(dir, "sample.txt"), `const key = "${AWS_KEY}"\n`);
        git(["add", "."]);
        git(["commit", "-m", "init"]);
        writeFileSync(join(dir, "a.txt"), `v2\nconst key = "${AWS_KEY}"\n`);
        git(["add", "a.txt"]);
        const { status, responses, stderr } = runServer(dir, [
            {
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
            },
            { jsonrpc: "2.0", id: 2, method: "resources/list" },
            { jsonrpc: "2.0", id: 3, method: "resources/templates/list" },
            { jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: "oc-pilot://config" } },
            { jsonrpc: "2.0", id: 5, method: "resources/read", params: { uri: "oc-pilot://prompt/en" } },
            { jsonrpc: "2.0", id: 6, method: "resources/read", params: { uri: "oc-pilot://diff/staged" } },
            { jsonrpc: "2.0", id: 7, method: "resources/read", params: { uri: "oc-pilot://scan/staged" } },
            { jsonrpc: "2.0", id: 8, method: "resources/read", params: { uri: "oc-pilot://file/sample.txt" } },
            { jsonrpc: "2.0", id: 9, method: "resources/read", params: { uri: "oc-pilot://file/..%2Fescape.txt" } },
            { jsonrpc: "2.0", id: 10, method: "resources/read", params: { uri: "oc-pilot://unknown" } },
        ]);
        assert.equal(status, 0, stderr);
        const byId = new Map(responses.map((response) => [response.id, response]));
        const init = byId.get(1)?.result;
        assert.ok(init?.capabilities?.resources, "resources capability missing");
        assert.ok(init?.capabilities?.resourceTemplates, "resourceTemplates capability missing");
        const list = byId.get(2)?.result;
        const uris = new Set(list?.resources?.map((resource) => resource.uri));
        for (const uri of ["oc-pilot://config", "oc-pilot://rules", "oc-pilot://version", "oc-pilot://prompt/en", "oc-pilot://prompt/ru"]) {
            assert.ok(uris.has(uri), uri);
        }
        const templates = byId.get(3)?.result;
        const templateIds = new Set(templates?.resourceTemplates?.map((template) => template.uriTemplate));
        for (const template of ["oc-pilot://diff/{mode}", "oc-pilot://scan/{mode}", "oc-pilot://file/{+path}"]) {
            assert.ok(templateIds.has(template), template);
        }
        const config = byId.get(4)?.result;
        const configJson = JSON.parse(config?.contents?.[0]?.text ?? "{}");
        assert.equal(configJson.config?.engine, "opencode");
        const prompt = byId.get(5)?.result;
        assert.match(prompt?.contents?.[0]?.text ?? "", /ROLE AND GOAL/);
        const diff = byId.get(6)?.result;
        const diffText = diff?.contents?.[0]?.text ?? "";
        assert.match(diffText, /\+v2/);
        assert.ok(!diffText.includes(AWS_KEY), "diff resource must redact secrets");
        const scan = byId.get(7)?.result;
        const scanText = scan?.contents?.[0]?.text ?? "";
        assert.match(scanText, /AWS Access Key ID/);
        assert.ok(!scanText.includes(AWS_KEY), "scan resource must not leak the raw secret");
        const file = byId.get(8)?.result;
        const fileText = file?.contents?.[0]?.text ?? "";
        assert.match(fileText, /REDACTED/);
        assert.ok(!fileText.includes(AWS_KEY), "file resource must redact secrets");
        assert.equal(byId.get(9)?.error?.code, -32002);
        assert.match(byId.get(9)?.error?.message ?? "", /inside the project/);
        assert.equal(byId.get(10)?.error?.code, -32002);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=mcp.test.js.map