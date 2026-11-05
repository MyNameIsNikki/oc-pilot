/**
 * License audit and CycloneDX SBOM for the resolved lockfile. Both work
 * offline: the SBOM needs only the lockfile, and licenses are read from the
 * installed packages when `node_modules` is present.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { LockedPackage } from "./lockfile.js";
import { VERSION } from "../version.js";

export type LicenseRisk = "permissive" | "weak-copyleft" | "strong-copyleft" | "unknown" | "proprietary";

export interface LicenseFinding {
  name: string;
  version: string;
  license: string;
  risk: LicenseRisk;
}

export interface LicenseAudit {
  checked: number;
  missing: number;
  findings: LicenseFinding[];
}

export interface SbomComponent {
  type: "library";
  name: string;
  version: string;
  purl: string;
}

export interface Sbom {
  bomFormat: "CycloneDX";
  specVersion: "1.5";
  version: 1;
  metadata: {
    timestamp: string;
    tools: Array<{ vendor: string; name: string; version: string }>;
    component: { type: "application"; name: string };
  };
  components: SbomComponent[];
}

const PERMISSIVE = ["mit", "isc", "bsd", "apache", "0bsd", "unlicense", "cc0", "wtfpl", "zlib", "python-2.0"];
const WEAK_COPYLEFT = ["lgpl", "mpl", "epl", "cddl"];

export function licenseRisk(license: string): LicenseRisk {
  const value = license.trim().toLowerCase();
  if (!value || value === "unknown" || value === "noassertion") return "unknown";
  if (value.includes("unlicensed") || value.includes("proprietary") || value.includes("see license")) return "proprietary";
  if (value.includes("agpl") || (value.includes("gpl") && !value.includes("lgpl"))) return "strong-copyleft";
  if (WEAK_COPYLEFT.some((marker) => value.includes(marker))) return "weak-copyleft";
  if (PERMISSIVE.some((marker) => value.includes(marker))) return "permissive";
  return "unknown";
}

function licenseOf(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const type = (value as { type?: unknown }).type;
    if (typeof type === "string" && type.trim().length > 0) return type.trim();
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = licenseOf(item);
      if (found) return found;
    }
  }
  return undefined;
}

/** Reads licenses from installed packages; absent `node_modules` is reported, not guessed. */
export function auditLicenses(cwd: string, packages: LockedPackage[]): LicenseAudit {
  const unique = new Map<string, LockedPackage>();
  for (const pkg of packages) {
    if (pkg.name && pkg.version) unique.set(`${pkg.name}@${pkg.version}`, pkg);
  }

  let checked = 0;
  let missing = 0;
  const findings: LicenseFinding[] = [];

  for (const pkg of unique.values()) {
    const manifestPath = join(cwd, "node_modules", pkg.name, "package.json");
    if (!existsSync(manifestPath)) {
      missing += 1;
      continue;
    }
    let manifest: { license?: unknown; licenses?: unknown };
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, "")) as typeof manifest;
    } catch {
      missing += 1;
      continue;
    }
    checked += 1;
    const license = licenseOf(manifest.license) ?? licenseOf(manifest.licenses) ?? "unknown";
    const risk = licenseRisk(license);
    if (risk !== "permissive") findings.push({ name: pkg.name, version: pkg.version, license, risk });
  }

  return { checked, missing, findings };
}

function purl(name: string, version: string): string {
  const encoded = name.startsWith("@") ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${encoded}@${version}`;
}

export function buildSbom(
  packages: LockedPackage[],
  packageName: string,
  timestamp = new Date().toISOString(),
): Sbom {
  const unique = new Map<string, LockedPackage>();
  for (const pkg of packages) {
    if (pkg.name && pkg.version) unique.set(`${pkg.name}@${pkg.version}`, pkg);
  }
  const components = [...unique.values()]
    .map((pkg) => ({ type: "library" as const, name: pkg.name, version: pkg.version, purl: purl(pkg.name, pkg.version) }))
    .sort((a, b) => a.purl.localeCompare(b.purl));

  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      timestamp,
      tools: [{ vendor: "oc-pilot", name: "oc-pilot", version: VERSION }],
      component: { type: "application", name: packageName },
    },
    components,
  };
}

export function writeSbom(cwd: string, file: string, sbom: Sbom): string {
  const absolute = isAbsolute(file) ? file : resolve(cwd, file);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(sbom, null, 2)}\n`, "utf8");
  return absolute;
}

export function renderLicenses(audit: LicenseAudit): string {
  const lines = [
    `Лицензии: проверено ${String(audit.checked)} пакетов` +
      (audit.missing > 0 ? `, без package.json ${String(audit.missing)} (node_modules не установлен?)` : "") +
      ".",
  ];
  if (audit.findings.length === 0) {
    lines.push("Лицензионных рисков не найдено.");
    return `${lines.join("\n")}\n`;
  }
  lines.push("Лицензионные риски:");
  for (const finding of audit.findings) {
    lines.push(`${finding.risk.padEnd(15)} ${finding.name}@${finding.version} — ${finding.license}`);
  }
  return `${lines.join("\n")}\n`;
}
