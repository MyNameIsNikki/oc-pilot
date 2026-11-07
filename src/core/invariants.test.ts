import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildInvariantsReport,
  cacheKey,
  gateExitCode,
  parseInvariants,
  parseVerdicts,
  readCachedVerdicts,
  renderInvariants,
  scopeInvariants,
  writeCachedVerdicts,
} from "./invariants.js";

const FILE = [
  "# Инварианты",
  "",
  "## billing",
  "- [CRITICAL] Сумма заказа всегда неотрицательна.",
  "- Валюта хранится в минорных единицах.",
  "",
  "## auth",
  "- Пароль никогда не логируется.",
  "",
].join("\n");

test("parseInvariants reads areas, critical marks and stable ids", () => {
  const items = parseInvariants(FILE);
  assert.equal(items.length, 3);
  assert.deepEqual(items[0], {
    id: "INV-001",
    text: "Сумма заказа всегда неотрицательна.",
    critical: true,
    area: "billing",
  });
  assert.equal(items[1]?.critical, false);
  assert.equal(items[2]?.area, "auth");
  assert.equal(items[2]?.id, "INV-003");
});

test("scopeInvariants skips invariants whose area matches no related file", () => {
  const items = parseInvariants(FILE);
  const { inScope, skipped } = scopeInvariants(items, ["src/billing/invoice.ts"]);
  assert.deepEqual(inScope.map((item) => item.id), ["INV-001", "INV-002"]);
  assert.deepEqual(skipped.map((item) => item.id), ["INV-003"]);
});

test("parseVerdicts fills missing and invalid answers with unknown", () => {
  const items = parseInvariants(FILE);
  const verdicts = parseVerdicts(
    'Вот результат: {"verdicts":[{"id":"INV-001","status":"violation","evidence":"total -= 10","file":"src/billing.ts","line":42},{"id":"INV-002","status":"maybe"}]}',
    items,
  );
  assert.equal(verdicts[0]?.status, "violation");
  assert.equal(verdicts[0]?.critical, true);
  assert.equal(verdicts[0]?.line, 42);
  assert.equal(verdicts[1]?.status, "unknown");
  assert.equal(verdicts[2]?.status, "unknown");
  assert.match(verdicts[2]?.evidence ?? "", /не вернула/i);
});

test("gateExitCode blocks critical violations and --strict only", () => {
  const items = parseInvariants(FILE);
  const critical = parseVerdicts('{"verdicts":[{"id":"INV-001","status":"violation","evidence":"x"}]}', items);
  const soft = parseVerdicts('{"verdicts":[{"id":"INV-002","status":"violation","evidence":"x"}]}', items);
  assert.equal(gateExitCode(critical), 3);
  assert.equal(gateExitCode(soft), 0);
  assert.equal(gateExitCode(soft, { strict: true }), 3);
  assert.equal(gateExitCode(parseVerdicts('{"verdicts":[]}', items)), 0);
});

test("renderInvariants marks violations, criticals and skips", () => {
  const items = parseInvariants(FILE);
  const verdicts = parseVerdicts('{"verdicts":[{"id":"INV-001","status":"violation","evidence":"x"}]}', items);
  verdicts[2] = { ...verdicts[2]!, status: "skipped", evidence: "[SKIPPED: Out of scope]" };
  const report = buildInvariantsReport(".oc-pilot/invariants.md", verdicts, false, { strict: false });
  assert.equal(report.violations, 1);
  assert.equal(report.criticalViolations, 1);
  assert.equal(report.skipped, 1);
  assert.equal(report.exitCode, 3);
  assert.match(renderInvariants(verdicts), /\[CRITICAL VIOLATION\]/);
  assert.match(renderInvariants(verdicts), /\[SKIPPED: Out of scope\]/);
});

test("cacheKey is deterministic and the cache round-trips", () => {
  assert.equal(cacheKey("diff", FILE), cacheKey("diff", FILE));
  assert.notEqual(cacheKey("diff", FILE), cacheKey("other", FILE));
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-invariants-"));
  try {
    const init = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    const verdicts = parseVerdicts('{"verdicts":[{"id":"INV-001","status":"pass","evidence":"ok"}]}', parseInvariants(FILE));
    const key = cacheKey("diff", FILE);
    writeCachedVerdicts(dir, key, verdicts);
    const cached = readCachedVerdicts(dir, key);
    assert.deepEqual(
      cached?.map((verdict) => ({ id: verdict.id, status: verdict.status })),
      verdicts.map((verdict) => ({ id: verdict.id, status: verdict.status })),
    );
    assert.equal(readCachedVerdicts(dir, "missing"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
