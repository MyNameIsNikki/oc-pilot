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

function startLoopback(
  content: string,
  verifierContent?: string,
): Promise<{ server: ReturnType<typeof createServer>; url: string }> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      const reply = body.includes('"verifier-model"') && verifierContent ? verifierContent : content;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
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

test("--no-test-weakening turns skipped tests into a policy failure", async () => {
  const dir = makeRepo("oc-pilot-review-weakening-");
  const { server, url } = await startLoopback("LGTM: no critical issues found.");
  try {
    writeFileSync(join(dir, "wallet.test.ts"), 'it.skip("deduct", () => {});\n');
    execSync("git add wallet.test.ts", { cwd: dir, stdio: "ignore" });
    const engine = ["--engine", "openai", "--model", "test-model", "--base-url", url, "--timeout", "30"];

    const soft = await runReview(["--cwd", dir, "--staged", "--fail-on", "none", ...engine]);
    assert.equal(soft, 0, "weakening is only a warning by default");

    const blocked = await runReview([
      "--cwd", dir,
      "--staged",
      "--no-test-weakening",
      "--fail-on", "none",
      ...engine,
    ]);
    assert.equal(blocked, 3, "--no-test-weakening must fail the run");
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--second-opinion downgrades rejected critical findings", async () => {
  const dir = makeRepo("oc-pilot-review-second-");
  const { server, url } = await startLoopback(ANALYSIS, "VERDICT: REJECT — speculative finding");
  try {
    stageChange(dir);
    const engine = ["--engine", "openai", "--model", "test-model", "--base-url", url, "--timeout", "30"];

    const verified = await runReview([
      "--cwd", dir,
      "--staged",
      "--fail-on", "critical",
      "--second-opinion",
      "--second-opinion-model", "verifier-model",
      "--no-cache",
      ...engine,
    ]);
    assert.equal(verified, 0, "a rejected critical finding must be downgraded and not fail the build");
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--require-tests fails logic-only changes", async () => {
  const dir = makeRepo("oc-pilot-review-tests-");
  const { server, url } = await startLoopback("LGTM: no critical issues found.");
  try {
    const lines = Array.from({ length: 30 }, (_, index) => `export const value${index} = ${index};`).join("\n");
    writeFileSync(join(dir, "logic.ts"), `${lines}\n`);
    execSync("git add logic.ts", { cwd: dir, stdio: "ignore" });

    const engine = ["--engine", "openai", "--model", "test-model", "--base-url", url, "--timeout", "30"];
    const code = await runReview(["--cwd", dir, "--staged", "--require-tests", ...engine]);
    assert.equal(code, 3, "logic changes without tests must fail with --require-tests");

    writeFileSync(join(dir, "logic.test.ts"), 'import "./logic.js";\n');
    execSync("git add logic.test.ts", { cwd: dir, stdio: "ignore" });
    const withTests = await runReview(["--cwd", dir, "--staged", "--require-tests", ...engine]);
    assert.equal(withTests, 0);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
