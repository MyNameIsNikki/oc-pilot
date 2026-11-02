import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRules } from "./rules.js";

const OPENAI_KEY = ["sk-proj-", "c".repeat(40)].join("");

test("loadRules reads .oc-pilot/rules.md and redacts secrets", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-rules-"));
  try {
    mkdirSync(join(dir, ".oc-pilot"));
    writeFileSync(join(dir, ".oc-pilot", "rules.md"), `# Rules\n\nAPI key: ${OPENAI_KEY}\n`);
    const rules = loadRules(dir);
    assert.ok(rules);
    assert.equal(rules.path, ".oc-pilot/rules.md");
    assert.ok(!rules.text.includes(OPENAI_KEY));
    assert.ok(rules.text.includes("[REDACTED:OpenAI API key]"));
    assert.equal(rules.findings.length, 1);
    assert.ok(rules.rawText.includes(OPENAI_KEY));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadRules returns undefined for the optional default file", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-rules-"));
  try {
    assert.equal(loadRules(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadRules finds .oc-pilot/rules.md in a parent directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-rules-"));
  try {
    mkdirSync(join(dir, ".oc-pilot"));
    writeFileSync(join(dir, ".oc-pilot", "rules.md"), "parent rules");
    const nested = join(dir, "src", "nested");
    mkdirSync(nested, { recursive: true });
    const rules = loadRules(nested);
    assert.ok(rules);
    assert.equal(rules.text.trim(), "parent rules");
    assert.match(rules.path, /\.oc-pilot\/rules\.md$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadRules fails when an explicit rules file is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-rules-"));
  try {
    assert.throws(() => loadRules(dir, "missing-rules.md"), /Файл правил не найден/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadRules truncates very large rule files", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-rules-"));
  try {
    writeFileSync(join(dir, "rules.md"), "x".repeat(30_000));
    const rules = loadRules(dir, "rules.md");
    assert.ok(rules);
    assert.equal(rules.truncated, true);
    assert.ok(rules.rawText.length <= 20_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
