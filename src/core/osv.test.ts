import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  auditVulnerabilities,
  fixedVersions,
  normalizeSeverity,
  renderVulnerabilities,
  severityAtLeast,
  type OsvAuditResult,
} from "./osv.js";
import type { LockedPackage } from "./lockfile.js";

function pkg(name: string, version: string): LockedPackage {
  return { name, version, deps: {} };
}

function response(results: unknown[]): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ results }),
  } as Response;
}

test("normalizeSeverity and fixedVersions read OSV metadata", () => {
  assert.equal(normalizeSeverity({ database_specific: { severity: "HIGH" } }), "high");
  assert.equal(normalizeSeverity({ ecosystem_specific: { severity: "medium" } }), "medium");
  assert.equal(normalizeSeverity({}), "unknown");
  assert.equal(normalizeSeverity({ database_specific: { severity: "moderate" } }), "unknown");

  const fixed = fixedVersions({
    affected: [
      { ranges: [{ events: [{ fixed: "1.2.0" }, { fixed: "1.0.1" }] }] },
      { ranges: [{ events: [{ fixed: "1.2.0" }] }] },
    ],
  });
  assert.deepEqual(fixed, ["1.0.1", "1.2.0"]);
});

test("auditVulnerabilities queries OSV once and reuses the cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-osv-"));
  try {
    const bodies: string[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return response([
        {
          vulns: [
            {
              id: "GHSA-1",
              aliases: ["CVE-1"],
              summary: "prototype pollution",
              database_specific: { severity: "high" },
              affected: [{ ranges: [{ events: [{ fixed: "2.0.0" }] }] }],
            },
          ],
        },
        {},
      ]);
    }) as typeof fetch;

    const result = await auditVulnerabilities(dir, [pkg("left-pad", "1.3.0"), pkg("zod", "3.0.0")], {
      fetchImpl,
      now: () => 1_000,
    });
    assert.equal(result.checked, 2);
    assert.equal(result.unchecked, 0);
    assert.equal(result.online, true);
    assert.equal(result.stale, false);
    assert.equal(result.vulnerabilities.length, 1);
    assert.equal(result.vulnerabilities[0]?.severity, "high");
    assert.deepEqual(result.vulnerabilities[0]?.fixed, ["2.0.0"]);
    assert.match(result.vulnerabilities[0]?.url ?? "", /GHSA-1/);
    assert.ok(result.cachePath && existsSync(result.cachePath));
    assert.match(bodies[0] ?? "", /left-pad/);

    const cached = await auditVulnerabilities(dir, [pkg("left-pad", "1.3.0"), pkg("zod", "3.0.0")], {
      fetchImpl: (async () => {
        throw new Error("network must not be used");
      }) as typeof fetch,
      now: () => 2_000,
    });
    assert.equal(cached.online, false);
    assert.equal(cached.checked, 2);
    assert.equal(cached.vulnerabilities.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("offline mode refuses an empty cache and reports partial coverage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-osv-offline-"));
  try {
    await assert.rejects(
      auditVulnerabilities(dir, [pkg("left-pad", "1.3.0")], { offline: true }),
      /Кеш OSV пуст/,
    );

    await auditVulnerabilities(dir, [pkg("left-pad", "1.3.0")], {
      fetchImpl: (async () => response([{}])) as typeof fetch,
      now: () => 1_000,
    });
    const partial = await auditVulnerabilities(dir, [pkg("left-pad", "1.3.0"), pkg("zod", "3.0.0")], {
      offline: true,
    });
    assert.equal(partial.checked, 1);
    assert.equal(partial.unchecked, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a network failure falls back to a stale cache but never to a silent pass", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-osv-stale-"));
  try {
    await auditVulnerabilities(dir, [pkg("left-pad", "1.3.0")], {
      fetchImpl: (async () => response([{ vulns: [{ id: "GHSA-1", summary: "bad" }] }])) as typeof fetch,
      now: () => 1_000,
    });
    const stale = await auditVulnerabilities(dir, [pkg("left-pad", "1.3.0")], {
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as typeof fetch,
      now: () => 10_000,
      ttlMs: 10,
    });
    assert.equal(stale.stale, true);
    assert.equal(stale.checked, 1);
    assert.equal(stale.vulnerabilities.length, 1);

    const empty = mkdtempSync(join(tmpdir(), "oc-pilot-osv-empty-"));
    try {
      await assert.rejects(
        auditVulnerabilities(empty, [pkg("left-pad", "1.3.0")], {
          fetchImpl: (async () => {
            throw new Error("offline");
          }) as typeof fetch,
        }),
        /Не удалось получить данные об уязвимостях/,
      );
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("severityAtLeast and renderVulnerabilities describe the verdict", () => {
  assert.equal(severityAtLeast("high", "high"), true);
  assert.equal(severityAtLeast("critical", "high"), true);
  assert.equal(severityAtLeast("medium", "high"), false);
  assert.equal(severityAtLeast("unknown", "low"), false);

  const result: OsvAuditResult = {
    checked: 2,
    unchecked: 1,
    vulnerabilities: [
      {
        id: "GHSA-2",
        aliases: [],
        summary: "medium issue",
        severity: "medium",
        package: "zod",
        version: "3.0.0",
        fixed: [],
        url: "https://osv.dev/vulnerability/GHSA-2",
      },
      {
        id: "GHSA-1",
        aliases: [],
        summary: "critical issue",
        severity: "critical",
        package: "left-pad",
        version: "1.3.0",
        fixed: ["1.3.1"],
        url: "https://osv.dev/vulnerability/GHSA-1",
      },
    ],
    online: true,
    stale: false,
    cachePath: null,
  };
  const text = renderVulnerabilities(result);
  assert.match(text, /проверено 2 из 3/);
  assert.match(text, /Без проверки: 1/);
  assert.ok(text.indexOf("GHSA-1") < text.indexOf("GHSA-2"), "critical must come first");
  assert.match(text, /исправлено в 1\.3\.1/);
  assert.ok(text.endsWith("\n"));

  const clean = renderVulnerabilities({ ...result, vulnerabilities: [], unchecked: 0, checked: 2 });
  assert.match(clean, /уязвимостей 0/);
});
