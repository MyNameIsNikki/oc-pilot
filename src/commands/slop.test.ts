import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { runGit } from "../core/git.js";
import { PilotError } from "../core/errors.js";
import { runSlop } from "./slop.js";

const BLOCK = [
  "function computeInvoiceTotal(items, taxRate, discountRate) {",
  "  let subtotal = 0;",
  "  for (const item of items) {",
  "    subtotal += item.price * item.quantity;",
  "  }",
  "  const taxed = subtotal * (1 + taxRate);",
  "  const discounted = taxed * (1 - discountRate);",
  "  return Math.round(discounted * 100) / 100;",
  "}",
].join("\n");

function makeRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-slop-"));
  runGit(["init", "-q"], dir);
  runGit(["config", "user.email", "tester@example.com"], dir);
  runGit(["config", "user.name", "Tester"], dir);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function commitFile(dir: string, file: string, content: string, message: string): void {
  const target = join(dir, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
  runGit(["add", file], dir);
  runGit(["commit", "-q", "-m", message], dir);
}

const WALLET_TEMPLATE = (marker: number): string =>
  `${BLOCK}\n\nexport function neverCalledHelper() {\n  return BLOCK_MARKER;\n}\n\n// TODO: убрать фолбэк перед релизом\nconst BLOCK_MARKER = ${String(marker)};\n`;

function seededRepo(): { dir: string; cleanup: () => void } {
  const repo = makeRepo();
  commitFile(repo.dir, "src/wallet.ts", WALLET_TEMPLATE(1), "add wallet");
  commitFile(repo.dir, "src/invoice.ts", `${BLOCK}\n\nconst invoiceLocal = 1;\n`, "add invoice");
  for (let index = 0; index < 5; index += 1) {
    commitFile(repo.dir, "src/wallet.ts", WALLET_TEMPLATE(index + 2), `touch wallet ${String(index)}`);
  }
  return repo;
}

test("slop scores a repository and reports every category", async () => {
  const repo = seededRepo();
  try {
    const out = join(repo.dir, "slop.json");
    assert.equal(await runSlop(["--cwd", repo.dir, "--json", "-o", out]), 0);

    const report = JSON.parse(readFileSync(out, "utf8")) as {
      index: number;
      grade: string;
      categories: Array<{ id: string; score: number }>;
      duplicates: Array<{ tokens: number }>;
      deadExports: Array<{ name: string }>;
      churn: Array<{ file: string }>;
      todos: Array<{ text: string }>;
      stats: { filesScanned: number };
    };

    assert.equal(report.categories.length, 4);
    assert.ok(report.index > 0);
    assert.match(report.grade, /^(чисто|умеренно|гниёт|критично)$/);
    assert.ok(report.duplicates.length >= 1);
    assert.ok(report.deadExports.some((item) => item.name === "neverCalledHelper"));
    assert.ok(report.churn.some((item) => item.file === "src/wallet.ts"));
    assert.ok(report.todos.some((item) => /фолбэк/.test(item.text)));
    assert.ok(report.stats.filesScanned >= 2);
  } finally {
    repo.cleanup();
  }
});

test("slop --max-index fails the run when the index is too high", async () => {
  const repo = seededRepo();
  try {
    assert.equal(
      await runSlop(["--cwd", repo.dir, "--json", "-o", join(repo.dir, "a.json"), "--max-index", "0"]),
      3,
    );
  } finally {
    repo.cleanup();
  }
});

test("slop --since reports a delta against a revision", async () => {
  const repo = seededRepo();
  try {
    const out = join(repo.dir, "delta.json");
    assert.equal(await runSlop(["--cwd", repo.dir, "--since", "HEAD~2", "--json", "-o", out]), 0);

    const payload = JSON.parse(readFileSync(out, "utf8")) as {
      index: number;
      delta: { base: string; deltaPoints: number; categories: Array<{ id: string; introduced: number; removed: number }> };
    };
    assert.equal(payload.delta.base, "HEAD~2");
    assert.equal(typeof payload.delta.deltaPoints, "number");
    assert.equal(payload.delta.categories.length, 4);
  } finally {
    repo.cleanup();
  }
});

test("slop --max-delta gates the delta", async () => {
  const repo = seededRepo();
  try {
    assert.equal(
      await runSlop([
        "--cwd",
        repo.dir,
        "--since",
        "HEAD~2",
        "--json",
        "-o",
        join(repo.dir, "d.json"),
        "--max-delta=-1000",
      ]),
      3,
    );
  } finally {
    repo.cleanup();
  }
});

test("slop --badge writes a shields-style SVG", async () => {
  const repo = seededRepo();
  try {
    const out = join(repo.dir, "badge.svg");
    assert.equal(await runSlop(["--cwd", repo.dir, "--badge", "-o", out]), 0);
    const svg = readFileSync(out, "utf8");
    assert.match(svg, /<svg/);
    assert.match(svg, /slop/);
  } finally {
    repo.cleanup();
  }
});

test("slop rejects an invalid limit", async () => {
  const repo = seededRepo();
  try {
    await assert.rejects(
      async () => runSlop(["--cwd", repo.dir, "--limit", "0"]),
      (error: unknown) => error instanceof PilotError && error.exitCode === 2 && /--limit/.test(error.message),
    );
  } finally {
    repo.cleanup();
  }
});

test("slop refuses to run outside a git repository", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-slop-plain-"));
  try {
    await assert.rejects(
      async () => runSlop(["--cwd", dir]),
      (error: unknown) => error instanceof PilotError && error.exitCode === 2 && /git/.test(error.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
