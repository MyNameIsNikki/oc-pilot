import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const MCP = resolve("dist/mcp.js");
const AWS_KEY = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

function runServer(
  dir: string,
  requests: unknown[],
  args: string[] = [],
): { status: number | null; responses: JsonRpcResponse[]; stderr: string } {
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
    .map((line) => JSON.parse(line) as JsonRpcResponse);
  return { status: result.status, responses, stderr: result.stderr ?? "" };
}

test("MCP initialize, tools/list and tools/call work over stdio", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-mcp-"));
  try {
    const diffPath = join(dir, "changes.diff");
    writeFileSync(
      diffPath,
      [
        "diff --git a/wallet.go b/wallet.go",
        "--- a/wallet.go",
        "+++ b/wallet.go",
        "@@ -1,1 +1,2 @@",
        " package wallet",
        `+const apiKey = "${AWS_KEY}"`,
        "",
      ].join("\n"),
    );

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

    const init = byId.get(1)?.result as { serverInfo?: { name?: string }; protocolVersion?: string } | undefined;
    assert.equal(init?.serverInfo?.name, "oc-pilot");
    assert.equal(init?.protocolVersion, "2025-06-18");

    const list = byId.get(2)?.result as { tools?: Array<{ name: string }> } | undefined;
    const names = new Set(list?.tools?.map((tool) => tool.name));
    for (const name of ["review", "test_fix", "fix", "docgen", "custom", "scan"]) assert.ok(names.has(name), name);

    const scan = byId.get(3)?.result as
      | {
          isError?: boolean;
          structuredContent?: { findings?: Array<{ kind: string }> };
          content?: Array<{ type: string; text: string }>;
        }
      | undefined;
    assert.equal(scan?.isError, false);
    assert.ok(scan?.structuredContent?.findings?.some((finding) => finding.kind === "AWS Access Key ID"));
    assert.ok(scan?.content?.some((part) => part.type === "text" && part.text.includes("AWS Access Key ID")));
    assert.ok(!(scan?.content?.[0]?.text ?? "").includes(AWS_KEY));

    assert.equal(byId.get(4)?.error?.code, -32601);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP is read-only by default and rejects paths outside the project", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-mcp-policy-"));
  try {
    const { status, responses, stderr } = runServer(
      dir,
      [
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
      ],
      [],
    );

    assert.equal(status, 0, stderr);
    const byId = new Map(responses.map((response) => [response.id, response]));
    const pathResult = byId.get(1)?.result as { isError?: boolean; content?: Array<{ text: string }> } | undefined;
    assert.equal(pathResult?.isError, true);
    assert.match(pathResult?.content?.[0]?.text ?? "", /inside the project/);

    const fixResult = byId.get(2)?.result as { isError?: boolean; content?: Array<{ text: string }> } | undefined;
    assert.equal(fixResult?.isError, true);
    assert.match(fixResult?.content?.[0]?.text ?? "", /read-only/);

    const testResult = byId.get(3)?.result as { isError?: boolean; content?: Array<{ text: string }> } | undefined;
    assert.equal(testResult?.isError, true);
    assert.match(testResult?.content?.[0]?.text ?? "", /read-only/);
  } finally {
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
    const response = JSON.parse(result.stdout.trim()) as JsonRpcResponse;
    assert.equal(response.error?.code, -32700);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
