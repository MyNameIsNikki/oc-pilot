import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const CLI = resolve("dist/cli.js");

function run(args: string[], cwd: string) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    maxBuffer: 8 * 1024 * 1024,
  });
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "oc-pilot-setup-"));
}

test("setup --print merges Claude config and keeps other servers", () => {
  const dir = tempDir();
  try {
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "other-mcp" } } }),
      "utf8",
    );
    const result = run(["setup", "--print", "--client", "claude", "--local", "--json", "--cwd", dir], dir);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      clients: Array<{ id: string; config: { mcpServers: Record<string, { command: string; args: string[] }> } }>;
    };
    const claude = payload.clients.find((client) => client.id === "claude");
    assert.ok(claude);
    assert.equal(claude.config.mcpServers.other?.command, "other-mcp");
    const entry = claude.config.mcpServers["oc-pilot"];
    assert.equal(entry?.command, process.execPath);
    assert.match(entry?.args[0] ?? "", /mcp\.js$/);
    assert.deepEqual(entry?.args.slice(1), ["--cwd", dir]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup --npx runs the MCP subcommand with a pinned version", () => {
  const dir = tempDir();
  try {
    const result = run(["setup", "--npx", "--print", "--client", "claude", "--json", "--cwd", dir], dir);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      clients: Array<{ config: { mcpServers: Record<string, { command: string; args: string[] }> } }>;
    };
    const entry = payload.clients[0]?.config.mcpServers["oc-pilot"];
    assert.equal(entry?.command, "npx");
    assert.equal(entry?.args[0], "-y");
    assert.match(entry?.args[1] ?? "", /^oc-pilot@\d+\.\d+\.\d+$/);
    assert.equal(entry?.args[2], "mcp");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup defaults to this installation", () => {
  const dir = tempDir();
  try {
    const result = run(["setup", "--print", "--client", "claude", "--json", "--cwd", dir], dir);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      clients: Array<{ config: { mcpServers: Record<string, { command: string; args: string[] }> } }>;
    };
    const entry = payload.clients[0]?.config.mcpServers["oc-pilot"];
    assert.equal(entry?.command, process.execPath);
    assert.match(entry?.args[0] ?? "", /mcp\.js$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup --allow-write enables write tools in the generated config", () => {
  const dir = tempDir();
  try {
    const result = run(
      ["setup", "--print", "--client", "claude", "--local", "--allow-write", "--json", "--cwd", dir],
      dir,
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      clients: Array<{ config: { mcpServers: Record<string, { args: string[] }> } }>;
    };
    const args = payload.clients[0]?.config.mcpServers["oc-pilot"]?.args ?? [];
    assert.ok(args.includes("--allow-write"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup rejects --local with --npx", () => {
  const dir = tempDir();
  try {
    const result = run(["setup", "--local", "--npx", "--print", "--cwd", dir], dir);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /mutually exclusive/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup writes OpenCode and Cursor project configs", () => {
  const dir = tempDir();
  try {
    const result = run(
      ["setup", "--client", "opencode", "--client", "cursor", "--local", "--cwd", dir],
      dir,
    );
    assert.equal(result.status, 0, result.stderr);

    const opencode = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8")) as {
      mcp: { servers: Record<string, { type: string; command: string[]; enabled: boolean }> };
    };
    const server = opencode.mcp.servers["oc-pilot"];
    assert.equal(server?.type, "local");
    assert.equal(server?.enabled, true);
    assert.match(server?.command[0] ?? "", /node(\.exe)?$/i);

    const cursor = JSON.parse(readFileSync(join(dir, ".cursor", "mcp.json"), "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    assert.equal(cursor.mcpServers["oc-pilot"]?.command, process.execPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup --http builds remote config with bearer auth", () => {
  const dir = tempDir();
  try {
    const result = run(
      [
        "setup",
        "--print",
        "--client",
        "claude",
        "--http",
        "https://example.com/mcp",
        "--token",
        "secret-token",
        "--json",
      ],
      dir,
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      clients: Array<{ config: { mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }> } }>;
    };
    const entry = payload.clients[0]?.config.mcpServers["oc-pilot"];
    assert.equal(entry?.type, "http");
    assert.equal(entry?.url, "https://example.com/mcp");
    assert.equal(entry?.headers.Authorization, "Bearer secret-token");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup prints a Codex TOML block", () => {
  const dir = tempDir();
  try {
    const result = run(["setup", "--print", "--client", "codex", "--local", "--json"], dir);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as { clients: Array<{ toml: string }> };
    assert.match(payload.clients[0]?.toml ?? "", /\[mcp_servers\.oc_pilot\]/);
    assert.match(payload.clients[0]?.toml ?? "", /args = \[/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup rejects an unknown client", () => {
  const dir = tempDir();
  try {
    const result = run(["setup", "--client", "nope"], dir);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Unknown client/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
