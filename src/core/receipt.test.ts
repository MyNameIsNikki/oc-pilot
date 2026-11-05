import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PreflightReport } from "./preflight.js";
import {
  RECEIPT_VERSION,
  buildReceipt,
  generateReceiptKeyPair,
  readReceipt,
  receiptHash,
  receiptPath,
  renderReceipt,
  saveReceipt,
  signReceipt,
  verifyReceipt,
  type ReceiptBody,
} from "./receipt.js";

const REPORT: PreflightReport = {
  status: "pass",
  diff: { source: "git diff HEAD", files: 1, additions: 2, deletions: 0 },
  checks: [
    { id: "secrets", label: "Секреты", status: "pass", summary: "секретов не найдено", details: [] },
    { id: "deps", label: "Зависимости", status: "pass", summary: "проблем нет", details: [] },
  ],
};

function body(commit: string | null): ReceiptBody {
  return {
    version: RECEIPT_VERSION,
    tool: "oc-pilot",
    toolVersion: "0.33.0",
    createdAt: "2026-11-05T00:00:00.000Z",
    commit,
    branch: "main",
    dirty: false,
    diff: { files: 1, additions: 2, deletions: 0 },
    files: ["src/a.ts"],
    tests: {
      command: "npm test",
      exitCode: 0,
      timedOut: false,
      durationMs: 12,
      passed: true,
      outputTail: "ok",
    },
    preflight: REPORT,
  };
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-receipt-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n", "utf8");
  spawnSync("git", ["add", "a.ts"], { cwd: dir });
  spawnSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "init"], {
    cwd: dir,
  });
  return dir;
}

function head(dir: string): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" });
  return result.stdout.trim();
}

test("receiptHash is stable and covers the body", () => {
  assert.equal(receiptHash(body(null)), receiptHash(body(null)));
  assert.notEqual(receiptHash(body(null)), receiptHash({ ...body(null), files: ["src/b.ts"] }));
});

test("buildReceipt round-trips through verifyReceipt", () => {
  const dir = makeRepo();
  try {
    const receipt = buildReceipt(body(head(dir)));
    const verification = verifyReceipt(dir, receipt);
    assert.equal(verification.ok, true);
    assert.equal(verification.hashOk, true);
    assert.equal(verification.stale, false);
    assert.equal(verification.reason, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyReceipt rejects a tampered body", () => {
  const dir = makeRepo();
  try {
    const receipt = buildReceipt(body(head(dir)));
    const tampered = { ...receipt, tests: { ...receipt.tests!, passed: false } };
    const verification = verifyReceipt(dir, tampered);
    assert.equal(verification.ok, false);
    assert.equal(verification.hashOk, false);
    assert.match(verification.reason ?? "", /хеш не совпадает/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyReceipt marks a receipt stale after a new commit", () => {
  const dir = makeRepo();
  try {
    const receipt = buildReceipt(body(head(dir)));
    writeFileSync(join(dir, "a.ts"), "export const a = 2;\n", "utf8");
    spawnSync("git", ["add", "a.ts"], { cwd: dir });
    spawnSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "next"], {
      cwd: dir,
    });

    const verification = verifyReceipt(dir, receipt);
    assert.equal(verification.ok, false);
    assert.equal(verification.stale, true);
    assert.match(verification.reason ?? "", /HEAD/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveReceipt stores under .git and reads back", () => {
  const dir = makeRepo();
  try {
    const receipt = buildReceipt(body(head(dir)));
    const saved = saveReceipt(dir, receipt);
    assert.equal(saved, receiptPath(dir));
    assert.equal(existsSync(saved), true);
    const loaded = readReceipt(saved);
    assert.equal(loaded.hash, receipt.hash);
    assert.equal(verifyReceipt(dir, loaded).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveReceipt outside a repository requires an explicit path", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-receipt-plain-"));
  try {
    const receipt = buildReceipt(body(null));
    assert.throws(() => saveReceipt(dir, receipt), /--out/);
    const saved = saveReceipt(dir, receipt, join(dir, "receipt.json"));
    assert.equal(readReceipt(saved).hash, receipt.hash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readReceipt reports a missing file", () => {
  assert.throws(() => readReceipt(join(tmpdir(), "oc-pilot-missing-receipt.json")), /не найдена/);
});

test("signReceipt signs the hash and verifies with the matching key", () => {
  const dir = makeRepo();
  try {
    const pair = generateReceiptKeyPair();
    const receipt = signReceipt(body(head(dir)), pair.privateKey);
    assert.equal(typeof receipt.signature, "string");
    assert.match(renderReceipt(receipt), /Подпись: Ed25519/);

    const checked = verifyReceipt(dir, receipt, pair.publicKey);
    assert.equal(checked.ok, true);
    assert.equal(checked.signature, "valid");

    const unchecked = verifyReceipt(dir, receipt);
    assert.equal(unchecked.ok, true);
    assert.equal(unchecked.signature, "unchecked");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyReceipt rejects a receipt signed by another key", () => {
  const dir = makeRepo();
  try {
    const pair = generateReceiptKeyPair();
    const other = generateReceiptKeyPair();
    const receipt = signReceipt(body(head(dir)), pair.privateKey);
    const checked = verifyReceipt(dir, receipt, other.publicKey);
    assert.equal(checked.ok, false);
    assert.equal(checked.signature, "invalid");
    assert.match(checked.reason ?? "", /подпись/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyReceipt requires a signature when a public key is given", () => {
  const dir = makeRepo();
  try {
    const pair = generateReceiptKeyPair();
    const receipt = buildReceipt(body(head(dir)));
    const checked = verifyReceipt(dir, receipt, pair.publicKey);
    assert.equal(checked.ok, false);
    assert.equal(checked.signature, "missing");
    assert.match(checked.reason ?? "", /не подписана/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("signReceipt rejects an invalid private key", () => {
  assert.throws(() => signReceipt(body(null), "not a key"), /приватный ключ/);
});

test("renderReceipt describes the run", () => {
  const receipt = buildReceipt(body("abcdef1234567890"));
  const text = renderReceipt(receipt, "/tmp/receipt.json");
  assert.match(text, /Квитанция: abcdef123456 \(main, чистое дерево\)/);
  assert.match(text, /Дифф: 1 файл\(ов\), \+2 \/ -0/);
  assert.match(text, /Тесты: npm test — пройдены \(12 мс\)/);
  assert.match(text, /Preflight: пройден — проверок с замечаниями: 0 из 2/);
  assert.match(text, /Хеш: /);
  assert.match(text, /Сохранено: \/tmp\/receipt\.json/);
  assert.equal(text.endsWith("\n"), true);
});
