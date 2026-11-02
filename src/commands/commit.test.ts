import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AddressInfo } from "node:net";
import { createServer } from "node:http";

import { runCommit, sanitizeCommitMessage, splitCommitMessage } from "./commit.js";
import { validateAnalysis } from "../core/format.js";

const COMMIT_MESSAGE = "feat: add balance guard\n\nChecks nil user and positive amount before deduction.";

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

test("sanitizeCommitMessage strips fences, labels and junk", () => {
  const fenced = "```\nfeat: fenced\n\nbody\n```";
  assert.equal(sanitizeCommitMessage(fenced), "feat: fenced\n\nbody");

  const labeled = "Commit message:\nfeat: labeled";
  assert.equal(sanitizeCommitMessage(labeled), "feat: labeled");

  const crlf = "feat: windows\r\n\r\nbody line\r\n";
  assert.equal(sanitizeCommitMessage(crlf), "feat: windows\n\nbody line");

  const blanks = "feat: spaced\n\n\n\nbody";
  assert.equal(sanitizeCommitMessage(blanks), "feat: spaced\n\nbody");

  const long = `feat: long\n\n${"x".repeat(6_000)}`;
  assert.ok(sanitizeCommitMessage(long).length <= 4_000);
});

test("splitCommitMessage separates subject and body", () => {
  const { subject, body } = splitCommitMessage("feat: subject\n\nbody line one\nbody line two");
  assert.equal(subject, "feat: subject");
  assert.equal(body, "body line one\nbody line two");

  const single = splitCommitMessage("chore: only subject");
  assert.equal(single.subject, "chore: only subject");
  assert.equal(single.body, "");
});

test("validateAnalysis never validates commit responses", () => {
  assert.deepEqual(validateAnalysis("anything at all", "commit"), []);
});

test("runCommit generates a message without committing", async () => {
  const dir = makeRepo("oc-pilot-commit-gen-");
  const { server, url } = await startLoopback(COMMIT_MESSAGE);
  try {
    writeFileSync(join(dir, "wallet.ts"), "export function deduct(): void {}\n");
    execSync("git add wallet.ts", { cwd: dir, stdio: "ignore" });

    const code = await runCommit([
      "--cwd", dir,
      "--engine", "openai",
      "--model", "test-model",
      "--base-url", url,
      "--timeout", "30",
    ]);
    assert.equal(code, 0);

    const count = execSync("git rev-list --count HEAD", { cwd: dir }).toString().trim();
    assert.equal(count, "1", "nothing should be committed without --apply");
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCommit --apply commits the generated message", async () => {
  const dir = makeRepo("oc-pilot-commit-apply-");
  const { server, url } = await startLoopback(COMMIT_MESSAGE);
  try {
    writeFileSync(join(dir, "wallet.ts"), "export function deduct(): void {}\n");
    execSync("git add wallet.ts", { cwd: dir, stdio: "ignore" });

    const code = await runCommit([
      "--cwd", dir,
      "--engine", "openai",
      "--model", "test-model",
      "--base-url", url,
      "--timeout", "30",
      "--apply",
    ]);
    assert.equal(code, 0);

    const message = execSync("git log -1 --pretty=%B", { cwd: dir }).toString();
    assert.match(message, /feat: add balance guard/);
    assert.match(message, /Checks nil user/);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCommit --apply refuses to commit critical secrets", async () => {
  const dir = makeRepo("oc-pilot-commit-secret-");
  const { server, url } = await startLoopback(COMMIT_MESSAGE);
  const awsKey = ["AKIA", "Q2WSXEDCRFVTGBYH"].join("");
  try {
    writeFileSync(join(dir, "config.ts"), `export const key = "${awsKey}";\n`);
    execSync("git add config.ts", { cwd: dir, stdio: "ignore" });

    const code = await runCommit([
      "--cwd", dir,
      "--engine", "openai",
      "--model", "test-model",
      "--base-url", url,
      "--timeout", "30",
      "--apply",
    ]);
    assert.equal(code, 3);

    const count = execSync("git rev-list --count HEAD", { cwd: dir }).toString().trim();
    assert.equal(count, "1", "HEAD must stay unchanged when secrets block the commit");

    const allowed = await runCommit([
      "--cwd", dir,
      "--engine", "openai",
      "--model", "test-model",
      "--base-url", url,
      "--timeout", "30",
      "--apply",
      "--allow-secrets",
    ]);
    assert.equal(allowed, 0);
    const after = execSync("git rev-list --count HEAD", { cwd: dir }).toString().trim();
    assert.equal(after, "2");
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCommit exits cleanly when there is nothing staged", async () => {
  const dir = makeRepo("oc-pilot-commit-empty-");
  const { server, url } = await startLoopback(COMMIT_MESSAGE);
  try {
    const code = await runCommit([
      "--cwd", dir,
      "--engine", "openai",
      "--model", "test-model",
      "--base-url", url,
      "--timeout", "30",
    ]);
    assert.equal(code, 0);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
