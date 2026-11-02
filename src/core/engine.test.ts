import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, test } from "node:test";
import { runOpenAiCompatible } from "./engine.js";

const KEY = "test-api-key-1234567890";

interface Capture {
  url?: string;
  authorization?: string;
  body?: Record<string, unknown>;
}

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse, capture: Capture) => void,
): Promise<{ baseUrl: string; capture: Capture; server: Server }> {
  const capture: Capture = {};
  const server = createServer((request, response) => {
    capture.url = request.url;
    capture.authorization = request.headers.authorization;
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      raw += chunk;
    });
    request.on("end", () => {
      try {
        capture.body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        capture.body = {};
      }
      handler(request, response, capture);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no server address");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, capture, server };
}

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("runOpenAiCompatible calls /chat/completions and returns text", async () => {
  const { baseUrl, capture, server } = await startServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        choices: [{ message: { content: "### Analysis: OK\n\n#### Findings / Actions\n- none\n\n#### Solution\n- none" } }],
      }),
    );
  });
  servers.push(server);
  process.env.OC_PILOT_ENGINE_TEST_KEY = KEY;

  const result = await runOpenAiCompatible({
    systemPrompt: "SYSTEM",
    input: "INPUT",
    baseUrl,
    apiKeyEnv: "OC_PILOT_ENGINE_TEST_KEY",
    model: "test-model",
    timeoutMs: 5_000,
  });

  assert.match(result.text, /### Analysis/);
  assert.equal(capture.url, "/v1/chat/completions");
  assert.equal(capture.authorization, `Bearer ${KEY}`);
  assert.equal(capture.body?.model, "test-model");
  const messages = capture.body?.messages as Array<{ role: string; content: string }>;
  assert.equal(messages[0]?.role, "system");
  assert.equal(messages[0]?.content, "SYSTEM");
  assert.equal(messages[1]?.content, "INPUT");
  assert.ok(result.durationMs >= 0);
});

test("runOpenAiCompatible accepts array content parts", async () => {
  const { baseUrl, server } = await startServer((_request, response) => {
    response.end(JSON.stringify({ choices: [{ message: { content: [{ type: "text", text: "part one" }, { text: "part two" }] } }] }));
  });
  servers.push(server);

  const result = await runOpenAiCompatible({
    systemPrompt: "s",
    input: "i",
    baseUrl,
    model: "m",
    timeoutMs: 5_000,
  });
  assert.equal(result.text, "part one\npart two");
});

test("runOpenAiCompatible sanitizes provider errors", async () => {
  const { baseUrl, server } = await startServer((_request, response) => {
    response.statusCode = 401;
    response.end(JSON.stringify({ error: { message: `invalid key ${KEY}` } }));
  });
  servers.push(server);
  process.env.OC_PILOT_ENGINE_TEST_KEY = KEY;

  await assert.rejects(
    runOpenAiCompatible({
      systemPrompt: "s",
      input: "i",
      baseUrl,
      apiKeyEnv: "OC_PILOT_ENGINE_TEST_KEY",
      model: "m",
      timeoutMs: 5_000,
    }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const hint = (error as { hint?: string }).hint ?? "";
      assert.match(message, /HTTP 401/);
      assert.doesNotMatch(`${message}\n${hint}`, new RegExp(KEY));
      assert.match(hint, /REDACTED/);
      return true;
    },
  );
});

test("runOpenAiCompatible requires a model and a key for remote URLs", async () => {
  await assert.rejects(
    runOpenAiCompatible({ systemPrompt: "s", input: "i", model: "", timeoutMs: 1 }),
    /нужна модель/,
  );
  await assert.rejects(
    runOpenAiCompatible({
      systemPrompt: "s",
      input: "i",
      baseUrl: "https://example.invalid/v1",
      apiKeyEnv: "OC_PILOT_ENGINE_MISSING_KEY",
      model: "m",
      timeoutMs: 1,
    }),
    /Не найден API-ключ/,
  );
});

test("runOpenAiCompatible allows a keyless local endpoint", async () => {
  const { baseUrl, capture, server } = await startServer((_request, response) => {
    response.end(JSON.stringify({ choices: [{ message: { content: "local" } }] }));
  });
  servers.push(server);

  const result = await runOpenAiCompatible({
    systemPrompt: "s",
    input: "i",
    baseUrl,
    apiKeyEnv: "OC_PILOT_ENGINE_MISSING_KEY",
    model: "m",
    timeoutMs: 5_000,
  });
  assert.equal(result.text, "local");
  assert.equal(capture.authorization, undefined);
});

test("runOpenAiCompatible reports a timeout", async () => {
  const { baseUrl, server } = await startServer((_request, response) => {
    setTimeout(() => response.end(JSON.stringify({ choices: [{ message: { content: "late" } }] })), 300);
  });
  servers.push(server);

  await assert.rejects(
    runOpenAiCompatible({
      systemPrompt: "s",
      input: "i",
      baseUrl,
      model: "m",
      timeoutMs: 20,
    }),
    /не ответил вовремя/,
  );
});
