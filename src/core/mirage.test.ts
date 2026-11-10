import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { clearMirage, listCassettes, readCassette, runMirage } from "./mirage.js";

async function startServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("hello from mirage");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      }),
  };
}

test("mirage records fetch and clock, then replays them without the network", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-mirage-"));
  const server = await startServer();
  try {
    writeFileSync(
      join(dir, "fetch.mjs"),
      [
        `const response = await fetch("http://127.0.0.1:${String(server.port)}/data");`,
        "console.log(await response.text());",
        "console.log(Date.now());",
        "",
      ].join("\n"),
      "utf8",
    );
    const cassette = ".oc-pilot/mirage/fetch.json";
    const recorded = await runMirage(dir, {
      mode: "record",
      command: "node fetch.mjs",
      cassette,
      timeoutMs: 20_000,
    });
    assert.equal(recorded.status, "ok", recorded.summary);
    assert.ok(recorded.entries >= 1);
    assert.ok(recorded.clock >= 1);
    assert.match(recorded.summary, /\[MIRAGE RECORDED\]/);

    const stored = readCassette(join(dir, cassette));
    assert.equal(stored?.entries[0]?.body, "hello from mirage");

    await server.close();

    const replayed = await runMirage(dir, {
      mode: "replay",
      command: "node fetch.mjs",
      cassette,
      timeoutMs: 20_000,
    });
    assert.equal(replayed.status, "ok", replayed.summary);
    assert.equal(replayed.output, recorded.output);
    assert.match(replayed.summary, /\[MIRAGE REPLAYED\]/);

    const listed = listCassettes(dir);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.entries, 1);
    assert.equal(clearMirage(dir).removed, 1);
    assert.deepEqual(listCassettes(dir), []);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mirage replay reports a miss for an unrecorded request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-mirage-miss-"));
  const server = await startServer();
  try {
    writeFileSync(
      join(dir, "fetch.mjs"),
      `const response = await fetch("http://127.0.0.1:${String(server.port)}/data");\nconsole.log(await response.text());\n`,
      "utf8",
    );
    const cassette = ".oc-pilot/mirage/miss.json";
    await runMirage(dir, { mode: "record", command: "node fetch.mjs", cassette, timeoutMs: 20_000 });
    await server.close();

    writeFileSync(
      join(dir, "miss.mjs"),
      `const response = await fetch("http://127.0.0.1:${String(server.port)}/other");\nconsole.log(await response.text());\n`,
      "utf8",
    );
    const missed = await runMirage(dir, {
      mode: "replay",
      command: "node miss.mjs",
      cassette,
      timeoutMs: 20_000,
    });
    assert.equal(missed.status, "miss");
    assert.notEqual(missed.exitCode, 0);
    assert.match(missed.summary, /\[MIRAGE MISS\]/);
    assert.match(missed.output, /MIRAGE MISS/);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mirage replays Date.now deterministically", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-mirage-clock-"));
  try {
    writeFileSync(join(dir, "clock.mjs"), "console.log(Date.now());\nconsole.log(Date.now());\n", "utf8");
    const cassette = ".oc-pilot/mirage/clock.json";
    const recorded = await runMirage(dir, {
      mode: "record",
      command: "node clock.mjs",
      cassette,
      timeoutMs: 20_000,
    });
    assert.equal(recorded.clock, 2);
    const replayed = await runMirage(dir, {
      mode: "replay",
      command: "node clock.mjs",
      cassette,
      timeoutMs: 20_000,
    });
    assert.equal(replayed.output, recorded.output);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
