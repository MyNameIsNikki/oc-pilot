import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  addQuarantine,
  checkQuarantine,
  clearQuarantine,
  listQuarantine,
  removeQuarantine,
} from "./quarantine.js";

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "oc-pilot-quarantine-"));
}

const NOW = new Date("2026-01-01T00:00:00.000Z");
const LATER = new Date("2026-01-16T00:00:00.000Z");

test("addQuarantine stores an entry and rejects duplicates and bad durations", () => {
  const dir = makeDir();
  try {
    const entry = addQuarantine(dir, {
      test: "src/flaky.test.ts",
      owner: "alice",
      reason: "timing race",
      days: 14,
      issue: "https://example.com/issues/1",
      now: NOW,
    });
    assert.equal(entry.test, "src/flaky.test.ts");
    assert.equal(entry.owner, "alice");
    assert.equal(entry.expiresAt, "2026-01-15T00:00:00.000Z");

    assert.throws(
      () =>
        addQuarantine(dir, {
          test: "src/flaky.test.ts",
          owner: "bob",
          reason: "again",
          days: 7,
          now: NOW,
        }),
      /уже на карантине/,
    );
    assert.throws(
      () =>
        addQuarantine(dir, {
          test: "other.test.ts",
          owner: "bob",
          reason: "x",
          days: 0,
          now: NOW,
        }),
      /от 1 до 365/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listQuarantine separates active and expired entries", () => {
  const dir = makeDir();
  try {
    addQuarantine(dir, { test: "a.test.ts", owner: "alice", reason: "race", days: 14, now: NOW });
    addQuarantine(dir, { test: "b.test.ts", owner: "bob", reason: "timeout", days: 30, now: NOW });

    const active = listQuarantine(dir, NOW);
    assert.equal(active.active.length, 2);
    assert.equal(active.expired.length, 0);
    assert.match(active.content, /\[ACTIVE\] a\.test\.ts/);

    const later = listQuarantine(dir, LATER);
    assert.equal(later.expired.length, 1);
    assert.equal(later.expired[0]?.test, "a.test.ts");
    assert.match(later.content, /\[EXPIRED\] a\.test\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkQuarantine reports active, expired and empty states", () => {
  const dir = makeDir();
  try {
    const empty = checkQuarantine(dir, NOW);
    assert.equal(empty.status, "empty");
    assert.match(empty.summary, /\[QUARANTINE EMPTY\]/);

    addQuarantine(dir, { test: "a.test.ts", owner: "alice", reason: "race", days: 14, now: NOW });
    const active = checkQuarantine(dir, NOW);
    assert.equal(active.status, "clean");
    assert.match(active.summary, /\[QUARANTINE ACTIVE\]/);

    const expired = checkQuarantine(dir, LATER);
    assert.equal(expired.status, "expired");
    assert.equal(expired.expired.length, 1);
    assert.match(expired.summary, /\[QUARANTINE EXPIRED\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeQuarantine and clearQuarantine manage the store", () => {
  const dir = makeDir();
  try {
    addQuarantine(dir, { test: "a.test.ts", owner: "alice", reason: "race", days: 14, now: NOW });
    addQuarantine(dir, { test: "b.test.ts", owner: "bob", reason: "timeout", days: 30, now: NOW });

    const removed = removeQuarantine(dir, "a.test.ts");
    assert.equal(removed.removed, true);
    assert.equal(removed.remaining, 1);
    assert.equal(removeQuarantine(dir, "a.test.ts").removed, false);

    assert.equal(clearQuarantine(dir).removed, 1);
    assert.deepEqual(listQuarantine(dir, NOW).entries, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
