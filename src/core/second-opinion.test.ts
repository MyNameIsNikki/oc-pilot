import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFindings } from "./findings.js";
import { downgradeFindingInText, parseVerdict, verifyCriticalFindings } from "./second-opinion.js";

const ANALYSIS = `### Analysis: one blocking finding.

#### Findings / Actions
- **🔴 Critical \`wallet.ts:5\`**: dangerous nil deref

#### Solution
none
`;

test("parseVerdict extracts confirm and reject with reason", () => {
  assert.deepEqual(parseVerdict("VERDICT: CONFIRM"), { verdict: "confirm" });
  const rejected = parseVerdict("VERDICT: REJECT — speculative, no evidence in diff");
  assert.equal(rejected.verdict, "reject");
  assert.equal(rejected.reason, "speculative, no evidence in diff");
  assert.deepEqual(parseVerdict("no verdict here"), { verdict: "confirm" });
});

test("downgradeFindingInText rewrites the bullet and keeps it parseable", () => {
  const finding = parseFindings(ANALYSIS)[0]!;
  const downgraded = downgradeFindingInText(ANALYSIS, finding, "speculative");
  assert.ok(downgraded.includes("second opinion: rejected — speculative"));
  const reparsed = parseFindings(downgraded);
  assert.equal(reparsed.length, 1);
  assert.equal(reparsed[0]?.severity, "style");
  assert.equal(reparsed[0]?.text, "dangerous nil deref [second opinion: rejected — speculative]");
});

test("downgradeFindingInText leaves text intact when the bullet is absent", () => {
  const untouched = downgradeFindingInText("## Header\n\nBody", { severity: "critical", text: "missing" }, "nope");
  assert.equal(untouched, "## Header\n\nBody");
});

async function startVerifierServer(response: string): Promise<{ server: Server; url: string; requests: () => number }> {
  let count = 0;
  const server = createServer((_request, response_2) => {
    count += 1;
    response_2.setHeader("content-type", "application/json");
    response_2.end(JSON.stringify({ choices: [{ message: { content: response } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}/v1`, requests: () => count };
}

test("verifyCriticalFindings rejects findings the verifier disputes", async () => {
  const { server, url, requests } = await startVerifierServer("VERDICT: REJECT — handled above");
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-so-"));
  try {
    const findings = parseFindings(ANALYSIS);
    const result = await verifyCriticalFindings(findings, ANALYSIS, {
      model: "verifier-model",
      baseUrl: url,
      timeoutMs: 30_000,
      cwd: dir,
    });
    assert.equal(requests(), 1);
    assert.equal(result.verified, 0);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0]?.index, 0);
    assert.equal(result.rejected[0]?.reason, "handled above");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    server.close();
  }
});

test("verifyCriticalFindings confirms findings the verifier accepts", async () => {
  const { server, url } = await startVerifierServer("VERDICT: CONFIRM");
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-so-"));
  try {
    const findings = parseFindings(ANALYSIS);
    const result = await verifyCriticalFindings(findings, ANALYSIS, {
      model: "verifier-model",
      baseUrl: url,
      timeoutMs: 30_000,
      cwd: dir,
    });
    assert.equal(result.verified, 1);
    assert.deepEqual(result.rejected, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    server.close();
  }
});
