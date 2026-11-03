import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { estimateCostUsd, runAnthropic } from "./engine.js";
import { PilotError } from "./errors.js";

interface Captured {
  path?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: Record<string, unknown>;
}

async function startServer(
  handler: (request: Captured, attempt: number) => { status: number; body: unknown; headers?: Record<string, string> },
): Promise<{ url: string; requests: () => number; captured: Captured[]; close: () => Promise<void> }> {
  const captured: Captured[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const item: Captured = {
        path: request.url,
        headers: request.headers,
        body: chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : undefined,
      };
      captured.push(item);
      const answer = handler(item, captured.length);
      response.writeHead(answer.status, { "content-type": "application/json", ...(answer.headers ?? {}) });
      response.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests: () => captured.length,
    captured,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const REPLY = {
  content: [
    { type: "text", text: "### Analysis: looks fine" },
    { type: "tool_use", id: "x" },
    { type: "text", text: "#### Findings\n- none" },
  ],
  usage: { input_tokens: 1_000, output_tokens: 200 },
};

test("runAnthropic sends a Messages API request with a cacheable system prompt", async () => {
  const server = await startServer(() => ({ status: 200, body: REPLY }));
  try {
    const result = await runAnthropic({
      systemPrompt: "SYSTEM",
      input: "USER",
      baseUrl: server.url,
      apiKeyEnv: "ANTHROPIC_TEST_KEY",
      model: "claude-sonnet-4-5",
      timeoutMs: 5_000,
    });

    assert.match(result.text, /looks fine/);
    assert.match(result.text, /Findings/);
    assert.deepEqual(result.usage, { promptTokens: 1_000, completionTokens: 200 });

    const request = server.captured[0]!;
    assert.equal(request.path, "/v1/messages");
    assert.equal(request.headers?.["anthropic-version"], "2023-06-01");
    assert.equal(request.body?.model, "claude-sonnet-4-5");
    assert.equal(request.body?.max_tokens, 8_192);
    const system = request.body?.system as Array<Record<string, unknown>>;
    assert.equal(system[0]?.text, "SYSTEM");
    assert.deepEqual(system[0]?.cache_control, { type: "ephemeral" });
    assert.deepEqual(request.body?.messages, [{ role: "user", content: "USER" }]);
  } finally {
    await server.close();
  }
});

test("runAnthropic requires a model", async () => {
  await assert.rejects(
    () =>
      runAnthropic({
        systemPrompt: "S",
        input: "U",
        baseUrl: "http://127.0.0.1:9/v1",
        model: "",
        timeoutMs: 1_000,
      }),
    (error: unknown) => error instanceof PilotError && error.exitCode === 2 && /anthropic/.test(error.message),
  );
});

test("runAnthropic retries transient failures", async () => {
  const server = await startServer((_request, attempt) =>
    attempt === 1 ? { status: 429, body: { error: { message: "slow down" } }, headers: { "retry-after": "0" } } : { status: 200, body: REPLY },
  );
  try {
    const result = await runAnthropic({
      systemPrompt: "S",
      input: "U",
      baseUrl: server.url,
      apiKeyEnv: "ANTHROPIC_TEST_KEY",
      model: "claude-sonnet-4-5",
      timeoutMs: 5_000,
      retryDelayMs: 0,
    });
    assert.match(result.text, /looks fine/);
    assert.equal(server.requests(), 2);
  } finally {
    await server.close();
  }
});

test("runAnthropic surfaces API errors without leaking the key", async () => {
  const server = await startServer(() => ({ status: 401, body: { error: { message: "invalid x-api-key" } } }));
  try {
    await assert.rejects(
      () =>
        runAnthropic({
          systemPrompt: "S",
          input: "U",
          baseUrl: server.url,
          apiKeyEnv: "ANTHROPIC_TEST_KEY",
          model: "claude-sonnet-4-5",
          timeoutMs: 5_000,
        }),
      (error: unknown) => error instanceof PilotError && error.exitCode === 1 && /HTTP 401/.test(error.message),
    );
  } finally {
    await server.close();
  }
});

test("estimateCostUsd knows Claude models", () => {
  const cost = estimateCostUsd("claude-sonnet-4-5", { promptTokens: 1_000_000, completionTokens: 0 });
  assert.equal(cost, 3);
});
