import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { LockedPackage } from "./lockfile.js";
import {
  auditLicenses,
  buildSbom,
  licenseRisk,
  renderLicenses,
  writeSbom,
  type LicenseAudit,
} from "./sbom.js";

function pkg(name: string, version: string): LockedPackage {
  return { name, version, deps: {} };
}

test("licenseRisk classifies common licenses", () => {
  assert.equal(licenseRisk("MIT"), "permissive");
  assert.equal(licenseRisk("Apache-2.0"), "permissive");
  assert.equal(licenseRisk("BSD-3-Clause"), "permissive");
  assert.equal(licenseRisk("GPL-3.0"), "strong-copyleft");
  assert.equal(licenseRisk("AGPL-3.0-only"), "strong-copyleft");
  assert.equal(licenseRisk("LGPL-2.1"), "weak-copyleft");
  assert.equal(licenseRisk("MPL-2.0"), "weak-copyleft");
  assert.equal(licenseRisk("UNLICENSED"), "proprietary");
  assert.equal(licenseRisk(""), "unknown");
  assert.equal(licenseRisk("Custom-Territory"), "unknown");
});

test("auditLicenses reads installed manifests and reports missing ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-sbom-licenses-"));
  try {
    const write = (name: string, value: unknown) => {
      const path = join(dir, "node_modules", name, "package.json");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(value), "utf8");
    };
    write("left-pad", { name: "left-pad", version: "1.3.0", license: "MIT" });
    write("@scope/ui", { name: "@scope/ui", version: "2.0.0", license: "GPL-3.0" });

    const audit = auditLicenses(dir, [
      pkg("left-pad", "1.3.0"),
      pkg("@scope/ui", "2.0.0"),
      pkg("zod", "3.0.0"),
    ]);
    assert.equal(audit.checked, 2);
    assert.equal(audit.missing, 1);
    assert.deepEqual(
      audit.findings.map((finding) => [finding.name, finding.risk, finding.license]),
      [["@scope/ui", "strong-copyleft", "GPL-3.0"]],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildSbom produces sorted CycloneDX components", () => {
  const sbom = buildSbom(
    [pkg("left-pad", "1.3.0"), pkg("@scope/ui", "2.0.0"), pkg("left-pad", "1.3.0")],
    "demo",
    "2026-01-01T00:00:00.000Z",
  );
  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.equal(sbom.specVersion, "1.5");
  assert.equal(sbom.metadata.component.name, "demo");
  assert.equal(sbom.metadata.timestamp, "2026-01-01T00:00:00.000Z");
  assert.equal(sbom.metadata.tools[0]?.name, "oc-pilot");
  assert.deepEqual(
    sbom.components.map((component) => component.purl),
    ["pkg:npm/%40scope/ui@2.0.0", "pkg:npm/left-pad@1.3.0"],
  );
});

test("writeSbom writes a nested path relative to the project", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-sbom-write-"));
  try {
    const sbom = buildSbom([pkg("left-pad", "1.3.0")], "demo");
    const path = writeSbom(dir, join("out", "sbom.json"), sbom);
    assert.equal(path, join(dir, "out", "sbom.json"));
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { bomFormat: string };
    assert.equal(parsed.bomFormat, "CycloneDX");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderLicenses lists risks and missing manifests", () => {
  const audit: LicenseAudit = {
    checked: 2,
    missing: 1,
    findings: [{ name: "left-pad", version: "1.3.0", license: "GPL-3.0", risk: "strong-copyleft" }],
  };
  const text = renderLicenses(audit);
  assert.match(text, /проверено 2 пакетов/);
  assert.match(text, /без package\.json 1/);
  assert.match(text, /strong-copyleft left-pad@1\.3\.0 — GPL-3\.0/);
  assert.ok(text.endsWith("\n"));

  const clean = renderLicenses({ checked: 2, missing: 0, findings: [] });
  assert.match(clean, /Лицензионных рисков не найдено/);
});
