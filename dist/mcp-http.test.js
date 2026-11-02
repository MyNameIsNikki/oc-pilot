import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
const MCP = resolve("dist/mcp.js");
async function startServer(args, cwd) {
    const child = spawn(process.execPath, [MCP, "--http", "--host", "127.0.0.1", "--port", "0", "--cwd", cwd, ...args], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
    });
    const url = await new Promise((resolvePromise, reject) => {
        let stderr = "";
        const timer = setTimeout(() => reject(new Error(`server did not start: ${stderr}`)), 10_000);
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
            const match = /listening on (http:\/\/[^\s]+)/.exec(stderr);
            if (match) {
                clearTimeout(timer);
                resolvePromise(match[1]);
            }
        });
        child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
    return { child, url };
}
async function stopServer(child) {
    if (child.exitCode !== null)
        return;
    const closed = once(child, "close");
    child.kill();
    await Promise.race([closed, new Promise((resolvePromise) => setTimeout(resolvePromise, 2000))]);
}
function cleanup(dir) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
async function rpc(url, payload, token) {
    return fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
    });
}
test("HTTP MCP exposes health, initialize, tools/list and fix", { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-http-"));
    const { child, url } = await startServer([], dir);
    try {
        const health = await fetch(url.replace(/\/mcp$/, "/health"));
        assert.equal(health.status, 200);
        const status = (await health.json());
        assert.equal(status.status, "ok");
        assert.equal(status.name, "oc-pilot");
        const initialized = await rpc(url, {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
        });
        assert.equal(initialized.status, 200);
        assert.ok(initialized.headers.get("mcp-session-id"));
        const init = (await initialized.json());
        assert.equal(init.result.serverInfo.name, "oc-pilot");
        const list = await rpc(url, { jsonrpc: "2.0", id: 2, method: "tools/list" });
        assert.equal(list.status, 200);
        const tools = (await list.json());
        const names = new Set(tools.result.tools.map((tool) => tool.name));
        for (const name of ["review", "test_fix", "fix", "docgen", "custom", "scan"])
            assert.ok(names.has(name), name);
    }
    finally {
        await stopServer(child);
        cleanup(dir);
    }
});
test("HTTP MCP enforces bearer auth", { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-http-auth-"));
    const { child, url } = await startServer(["--token", "secret-token"], dir);
    try {
        const unauthorized = await rpc(url, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
        assert.equal(unauthorized.status, 401);
        const authorized = await rpc(url, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, "secret-token");
        assert.equal(authorized.status, 200);
    }
    finally {
        await stopServer(child);
        cleanup(dir);
    }
});
test("HTTP MCP is read-only by default", { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-http-ro-"));
    const { child, url } = await startServer([], dir);
    try {
        const response = await rpc(url, {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "fix", arguments: { diff: "diff --git a/a b/a\n", apply: true } },
        });
        assert.equal(response.status, 200);
        const body = (await response.json());
        assert.equal(body.result?.isError, true);
        assert.match(body.result?.content?.[0]?.text ?? "", /read-only/);
    }
    finally {
        await stopServer(child);
        cleanup(dir);
    }
});
test("HTTP MCP refuses a public bind without a token", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-http-noauth-"));
    try {
        const result = spawnSync(process.execPath, [MCP, "--http", "--host", "0.0.0.0", "--port", "0", "--cwd", dir], {
            encoding: "utf8",
            timeout: 10_000,
        });
        assert.equal(result.status, 2);
        assert.match(result.stderr ?? "", /refusing to expose HTTP without a token/);
    }
    finally {
        cleanup(dir);
    }
});
test("HTTP MCP rejects GET on the MCP path", { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-http-get-"));
    const { child, url } = await startServer([], dir);
    try {
        const response = await fetch(url, { method: "GET" });
        assert.equal(response.status, 405);
        assert.equal(response.headers.get("allow"), "POST, OPTIONS");
    }
    finally {
        await stopServer(child);
        cleanup(dir);
    }
});
//# sourceMappingURL=mcp-http.test.js.map