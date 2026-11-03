import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { cachedRunOpenAi } from "./cache.js";
import { estimateCostUsd } from "./engine.js";
import { readStats, recordApiCall, sumCostSince } from "./stats.js";

function git(dir: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
}

const dirs: string[] = [];

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cost-"));
  dirs.push(dir);
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  return dir;
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("estimateCostUsd", () => {
  it("prices known models per million tokens", () => {
    assert.equal(estimateCostUsd("gpt-4.1-mini", { promptTokens: 1_000, completionTokens: 500 }), 0.0012);
    assert.equal(estimateCostUsd("gpt-4o", { promptTokens: 1_000_000, completionTokens: 0 }), 2.5);
  });

  it("matches dated model names by prefix", () => {
    assert.equal(estimateCostUsd("gpt-4.1-mini-2026-04-14", { promptTokens: 1_000_000, completionTokens: 0 }), 0.4);
  });

  it("returns undefined without usage or for unknown models", () => {
    assert.equal(estimateCostUsd("gpt-4.1-mini", undefined), undefined);
    assert.equal(estimateCostUsd("llama3.2", { promptTokens: 10, completionTokens: 10 }), undefined);
    assert.equal(estimateCostUsd(undefined, { promptTokens: 10, completionTokens: 10 }), undefined);
  });
});

describe("sumCostSince", () => {
  it("adds recorded costs and ignores older entries", () => {
    const dir = makeRepo();
    recordApiCall(dir, { model: "gpt-4.1-mini", cached: false, durationMs: 10, costUsd: 0.25 });
    recordApiCall(dir, { model: "gpt-4.1-mini", cached: true, durationMs: 0, costUsd: 0 });
    recordApiCall(dir, { model: "gpt-4.1-mini", cached: false, durationMs: 10, costUsd: 0.5 });
    const records = readStats(dir);
    assert.equal(sumCostSince(records, 0), 0.75);
    assert.equal(sumCostSince(records, Date.now() + 60_000), 0);
  });
});

describe("maxCostUsd gate", () => {
  it("refuses to call the API once today's spend reached the cap", async () => {
    const dir = makeRepo();
    recordApiCall(dir, { model: "gpt-4.1-mini", cached: false, durationMs: 10, costUsd: 2 });

    await assert.rejects(
      () =>
        cachedRunOpenAi({
          systemPrompt: "system",
          input: "input",
          model: "gpt-4.1-mini",
          baseUrl: "http://127.0.0.1:9/v1",
          cwd: dir,
          ttlSeconds: 0,
          timeoutMs: 30000,
          maxCostUsd: 1,
        }),
      /лимит расходов/,
    );
  });

  it("records the estimated cost of a real call", async () => {
    const dir = makeRepo();
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            choices: [{ message: { content: "LGTM: no critical issues found." } }],
            usage: { prompt_tokens: 100_000, completion_tokens: 50_000 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      await cachedRunOpenAi({
        systemPrompt: "system",
        input: "input",
        model: "gpt-4.1-mini",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        cwd: dir,
        ttlSeconds: 0,
        timeoutMs: 30000,
        maxCostUsd: 100,
      });
    } finally {
      server.close();
    }

    const spent = sumCostSince(readStats(dir), 0);
    assert.ok(spent > 0, "expected a recorded cost");
    assert.equal(spent, estimateCostUsd("gpt-4.1-mini", { promptTokens: 100_000, completionTokens: 50_000 }));
  });
});
