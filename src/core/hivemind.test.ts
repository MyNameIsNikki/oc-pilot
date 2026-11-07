import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  initIdentity,
  readIdentity,
  readPeers,
  sendMessage,
  startServer,
  trustPeer,
  validatePayload,
  type HivemindPayload,
} from "./hivemind.js";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-hivemind-"));
  return dir;
}

test("identity and trust files round-trip", () => {
  const dir = makeRepo();
  try {
    const identity = initIdentity(dir);
    assert.match(identity.publicKey, /BEGIN PUBLIC KEY/);
    assert.equal(readIdentity(dir)?.publicKey, identity.publicKey);
    trustPeer(dir, identity.publicKey);
    trustPeer(dir, identity.publicKey);
    assert.deepEqual(readPeers(dir), [identity.publicKey]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validatePayload allows analysis and rejects executable payloads", () => {
  assert.equal(validatePayload({ type: "diff", body: "x" }).ok, true);
  assert.equal(validatePayload({ type: "ast", body: "x" }).ok, true);
  assert.equal(validatePayload({ type: "exec", body: "rm -rf" }).ok, false);
  assert.equal(validatePayload({ type: "diff", command: "rm -rf" }).ok, false);
});

test("encrypted handshake delivers a diff and rejects an untrusted server", async () => {
  const serverRepo = makeRepo();
  const clientRepo = makeRepo();
  try {
    const serverIdentity = initIdentity(serverRepo);
    const clientIdentity = initIdentity(clientRepo);
    trustPeer(serverRepo, clientIdentity.publicKey);
    trustPeer(clientRepo, serverIdentity.publicKey);

    const received: HivemindPayload[] = [];
    const server = await startServer(serverRepo, {
      port: 0,
      onMessage: (payload) => received.push(payload),
    });
    try {
      const result = await sendMessage(clientRepo, {
        port: server.port,
        payload: { type: "diff", body: "diff --git a/x b/x" },
      });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.response?.type, "ack");
      assert.equal(received.length, 1);
      assert.equal(received[0]?.type, "diff");
      assert.equal(received[0]?.body, "diff --git a/x b/x");
    } finally {
      await server.close();
    }

    const server2 = await startServer(serverRepo, { port: 0, onMessage: () => {} });
    const otherRepo = makeRepo();
    try {
      initIdentity(otherRepo);
      const denied = await sendMessage(otherRepo, {
        port: server2.port,
        payload: { type: "diff", body: "x" },
      });
      assert.equal(denied.ok, false);
      assert.match(denied.error ?? "", /untrusted|not trusted|denied/);
    } finally {
      await server2.close();
      rmSync(otherRepo, { recursive: true, force: true });
    }
  } finally {
    rmSync(serverRepo, { recursive: true, force: true });
    rmSync(clientRepo, { recursive: true, force: true });
  }
});
