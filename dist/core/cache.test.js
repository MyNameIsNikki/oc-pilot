import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "node:http";
import { cacheKey, cacheRoot, cacheStats, cachedRunOpenAi, clearCache, pruneCache, } from "./cache.js";
function makeRepo(prefix) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    execSync("git init", { cwd: dir, stdio: "ignore" });
    execSync("git config user.email test@example.com", { cwd: dir, stdio: "ignore" });
    execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, "a.txt"), "one\n");
    execSync("git add -A", { cwd: dir, stdio: "ignore" });
    execSync("git commit -m init", { cwd: dir, stdio: "ignore" });
    return dir;
}
function startLoopback() {
    let count = 0;
    const server = createServer((request, response) => {
        request.resume();
        request.on("end", () => {
            count += 1;
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ choices: [{ message: { content: "cached-response" } }] }));
        });
    });
    return new Promise((resolvePromise) => {
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            resolvePromise({ server, url: `http://127.0.0.1:${port}/v1`, requests: () => count });
        });
    });
}
test("cacheKey is stable and sensitive to model and prompt", () => {
    const base = { systemPrompt: "sys", input: "in" };
    const first = cacheKey(base);
    assert.equal(cacheKey({ ...base }), first);
    assert.notEqual(cacheKey({ ...base, model: "other" }), first);
    assert.notEqual(cacheKey({ ...base, systemPrompt: "changed" }), first);
    assert.notEqual(cacheKey({ ...base, input: "changed" }), first);
    assert.notEqual(cacheKey({ ...base, baseUrl: "https://api.example.com/v1" }), first);
});
test("cachedRunOpenAi serves the second identical call from the cache", async () => {
    const dir = makeRepo("oc-pilot-cache-hit-");
    const { server, url, requests } = await startLoopback();
    try {
        const options = {
            systemPrompt: "sys",
            input: "in",
            model: "test-model",
            baseUrl: url,
            timeoutMs: 30_000,
            cwd: dir,
            ttlSeconds: 3_600,
        };
        const first = await cachedRunOpenAi(options);
        assert.equal(first.text, "cached-response");
        assert.notEqual(first.cached, true);
        const second = await cachedRunOpenAi(options);
        assert.equal(second.text, "cached-response");
        assert.equal(second.cached, true);
        assert.equal(second.durationMs, 0);
        assert.equal(requests(), 1);
    }
    finally {
        server.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
test("ttlSeconds=0 disables the cache", async () => {
    const dir = makeRepo("oc-pilot-cache-off-");
    const { server, url, requests } = await startLoopback();
    try {
        const options = {
            systemPrompt: "sys",
            input: "in",
            model: "test-model",
            baseUrl: url,
            timeoutMs: 30_000,
            cwd: dir,
            ttlSeconds: 0,
        };
        await cachedRunOpenAi(options);
        await cachedRunOpenAi(options);
        assert.equal(requests(), 2);
        assert.equal(cacheStats(dir)?.entries ?? 0, 0);
    }
    finally {
        server.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
test("a non-repo cwd bypasses the cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cache-norepo-"));
    const { server, url, requests } = await startLoopback();
    try {
        assert.equal(cacheRoot(dir), undefined);
        const options = {
            systemPrompt: "sys",
            input: "in",
            model: "test-model",
            baseUrl: url,
            timeoutMs: 30_000,
            cwd: dir,
            ttlSeconds: 3_600,
        };
        await cachedRunOpenAi(options);
        const second = await cachedRunOpenAi(options);
        assert.notEqual(second.cached, true);
        assert.equal(requests(), 2);
    }
    finally {
        server.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
test("pruneCache removes expired entries, clearCache removes everything", async () => {
    const dir = makeRepo("oc-pilot-cache-prune-");
    const { server, url } = await startLoopback();
    try {
        await cachedRunOpenAi({
            systemPrompt: "sys",
            input: "fresh",
            model: "test-model",
            baseUrl: url,
            timeoutMs: 30_000,
            cwd: dir,
            ttlSeconds: 3_600,
        });
        const root = cacheRoot(dir);
        const staleKey = cacheKey({ systemPrompt: "sys", input: "stale", model: "test-model" });
        writeFileSync(join(root, `${staleKey}.json`), JSON.stringify({ version: 1, createdAt: 0, expiresAt: 1, text: "old" }), "utf8");
        const stats = cacheStats(dir);
        assert.equal(stats.entries, 2);
        assert.equal(stats.expired, 1);
        assert.equal(pruneCache(dir), 1);
        const afterPrune = cacheStats(dir);
        assert.equal(afterPrune.entries, 1);
        assert.equal(afterPrune.expired, 0);
        assert.equal(clearCache(dir), 1);
        assert.equal(cacheStats(dir).entries, 0);
    }
    finally {
        server.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
test("cacheStats returns undefined when the cache directory does not exist", () => {
    const dir = makeRepo("oc-pilot-cache-empty-");
    try {
        assert.equal(cacheStats(dir), undefined);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=cache.test.js.map