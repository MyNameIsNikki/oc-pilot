import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AddressInfo } from "node:net";
import { createServer } from "node:http";

import { runReview } from "./review.js";
import { loadBaseline, writeBaseline } from "../core/baseline.js";
import { parseFindings } from "../core/findings.js";

const ANALYSIS = [
  "### Analysis: one blocking finding.",
  "",
  "#### Findings / Actions",
  "- **🔴 Critical `wallet.ts:5`**: dangerous nil deref",
  "",
  "#### Solution",
  "none",
].join("\n");

function makeRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync("git config user.email test@example.com", { cwd: dir, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
  execSync("git config core.autocrlf false", { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "init\n");
  execSync("git add -A", { cwd: dir, stdio: "ignore" });
  execSync("git commit -m init", { cwd: dir, stdio: "ignore" });
  return dir;
}

function stageChange(dir: string): void {
  writeFileSync(join(dir, "wallet.ts"), "export function deduct(): void {}\n");
  execSync("git add wallet.ts", { cwd: dir, stdio: "ignore" });
}

function startLoopback(content: string): Promise<{ server: ReturnType<typeof createServer>; url: string }> {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolvePromise({ server, url: `http://127.0.0.1:${port}/v1` });
    });
  });
}

test("--baseline hides known findings from the exit code", async () => {
  const dir = makeRepo("oc-pilot-review-baseline-");
  const { server, url } = await startLoopback(ANALYSIS);
  try {
    stageChange(dir);
    const finding = parseFindings(ANALYSIS)[0]!;
    const written = writeBaseline(dir, [finding]);
    assert.equal(written.count, 1);

    const engine = ["--engine", "openai", "--model", "test-model", "--base-url", url, "--timeout", "30"];

    const known = await runReview(["--cwd", dir, "--staged", "--baseline", "--fail-on", "critical", ...engine]);
    assert.equal(known, 0, "a fully known finding must not fail the build");

    const fresh = await runReview(["--cwd", dir, "--staged", "--fail-on", "critical", ...engine]);
    assert.equal(fresh, 3, "without --baseline the same finding must fail");
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--update-baseline records the current findings and exits 0", async () => {
  const dir = makeRepo("oc-pilot-review-update-");
  const { server, url } = await startLoopback(ANALYSIS);
  try {
    stageChange(dir);
    const engine = ["--engine", "openai", "--model", "test-model", "--base-url", url, "--timeout", "30"];

    const code = await runReview([
      "--cwd", dir,
      "--staged",
      "--fail-on", "critical",
      "--update-baseline",
      ...engine,
    ]);
    assert.equal(code, 0);

    const baseline = loadBaseline(dir);
    assert.equal(baseline.count, 1);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
