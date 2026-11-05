/**
 * OSV vulnerability audit. The network is used only when the caller asks for
 * it; every answer is cached under `.oc-pilot/osv-cache.json` so CI can run
 * offline and still fail on a known vulnerability.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PilotError } from "./errors.js";
import { compareVersions, type LockedPackage } from "./lockfile.js";

export type VulnSeverity = "critical" | "high" | "medium" | "low" | "unknown";

export interface Vulnerability {
  id: string;
  aliases: string[];
  summary: string;
  severity: VulnSeverity;
  package: string;
  version: string;
  fixed: string[];
  url: string;
}

export interface OsvAuditResult {
  checked: number;
  unchecked: number;
  vulnerabilities: Vulnerability[];
  online: boolean;
  stale: boolean;
  cachePath: string | null;
}

export interface OsvAuditOptions {
  /** Full querybatch endpoint; defaults to the public OSV API. */
  url?: string;
  offline?: boolean;
  cachePath?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
}

interface OsvRangeEvent {
  fixed?: string;
}

interface OsvAffected {
  ranges?: Array<{ events?: OsvRangeEvent[] }>;
}

interface OsvVulnerability {
  id?: string;
  aliases?: string[];
  summary?: string;
  details?: string;
  severity?: Array<{ type?: string; score?: string }>;
  database_specific?: { severity?: string };
  ecosystem_specific?: { severity?: string };
  affected?: OsvAffected[];
}

interface CacheEntry {
  checkedAt: number;
  vulns: Vulnerability[];
}

interface CacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

const DEFAULT_URL = "https://api.osv.dev/v1/querybatch";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 100;

const SEVERITY_WEIGHT: Record<VulnSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  unknown: 0,
};

function keyOf(pkg: LockedPackage): string {
  return `npm:${pkg.name}@${pkg.version}`;
}

function emptyCache(): CacheFile {
  return { version: 1, entries: {} };
}

function readCache(path: string): CacheFile {
  if (!existsSync(path)) return emptyCache();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as Partial<CacheFile>;
    if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") return emptyCache();
    return { version: 1, entries: parsed.entries };
  } catch {
    return emptyCache();
  }
}

function writeCache(path: string, cache: CacheFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

export function normalizeSeverity(vuln: OsvVulnerability): VulnSeverity {
  const raw = vuln.database_specific?.severity ?? vuln.ecosystem_specific?.severity;
  if (typeof raw === "string") {
    const value = raw.trim().toLowerCase();
    if (value === "critical" || value === "high" || value === "medium" || value === "low") return value;
  }
  return "unknown";
}

export function fixedVersions(vuln: OsvVulnerability): string[] {
  const found = new Set<string>();
  for (const affected of vuln.affected ?? []) {
    for (const range of affected.ranges ?? []) {
      for (const event of range.events ?? []) {
        if (typeof event.fixed === "string" && event.fixed.length > 0) found.add(event.fixed);
      }
    }
  }
  return [...found].sort(compareVersions);
}

function normalizeVuln(vuln: OsvVulnerability, pkg: LockedPackage): Vulnerability | undefined {
  const id = typeof vuln.id === "string" ? vuln.id : undefined;
  if (!id) return undefined;
  const summary = typeof vuln.summary === "string" && vuln.summary.length > 0
    ? vuln.summary
    : typeof vuln.details === "string" && vuln.details.length > 0
      ? vuln.details.split("\n")[0]!.slice(0, 200)
      : "без описания";
  return {
    id,
    aliases: Array.isArray(vuln.aliases) ? vuln.aliases.filter((alias): alias is string => typeof alias === "string") : [],
    summary,
    severity: normalizeSeverity(vuln),
    package: pkg.name,
    version: pkg.version,
    fixed: fixedVersions(vuln),
    url: `https://osv.dev/vulnerability/${id}`,
  };
}

async function queryBatch(
  url: string,
  packages: LockedPackage[],
  fetchImpl: typeof fetch,
): Promise<Map<string, Vulnerability[]>> {
  const body = JSON.stringify({
    queries: packages.map((pkg) => ({ package: { name: pkg.name, ecosystem: "npm" }, version: pkg.version })),
  });
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) throw new Error(`OSV вернул HTTP ${String(response.status)}`);
  const data = (await response.json()) as { results?: Array<{ vulns?: OsvVulnerability[] }> };
  const result = new Map<string, Vulnerability[]>();
  packages.forEach((pkg, index) => {
    const vulns = data.results?.[index]?.vulns ?? [];
    result.set(
      keyOf(pkg),
      vulns
        .map((vuln) => normalizeVuln(vuln, pkg))
        .filter((vuln): vuln is Vulnerability => vuln !== undefined),
    );
  });
  return result;
}

/**
 * Audits the resolved lockfile versions. Online answers are cached for a day;
 * an offline run with an empty cache is an error, never a silent "clean".
 */
export async function auditVulnerabilities(
  cwd: string,
  packages: LockedPackage[],
  options: OsvAuditOptions = {},
): Promise<OsvAuditResult> {
  const cachePath = options.cachePath ?? join(cwd, ".oc-pilot", "osv-cache.json");
  const cache = readCache(cachePath);
  const now = options.now ? options.now() : Date.now();
  const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
  const url = options.url ?? DEFAULT_URL;
  const fetchImpl = options.fetchImpl ?? fetch;

  const unique = new Map<string, LockedPackage>();
  for (const pkg of packages) {
    if (pkg.name && pkg.version) unique.set(keyOf(pkg), pkg);
  }
  const entries = [...unique.values()];

  const missing = entries.filter((pkg) => cache.entries[keyOf(pkg)] === undefined);
  const stale = entries.filter((pkg) => {
    const entry = cache.entries[keyOf(pkg)];
    return entry !== undefined && now - entry.checkedAt > ttl;
  });

  let online = false;
  let staleAnswer = false;

  if (!options.offline && missing.length + stale.length > 0) {
    const targets = [...missing, ...stale];
    try {
      for (let offset = 0; offset < targets.length; offset += BATCH_SIZE) {
        const chunk = targets.slice(offset, offset + BATCH_SIZE);
        const found = await queryBatch(url, chunk, fetchImpl);
        for (const pkg of chunk) {
          cache.entries[keyOf(pkg)] = { checkedAt: now, vulns: found.get(keyOf(pkg)) ?? [] };
        }
      }
      writeCache(cachePath, cache);
      online = true;
    } catch (error) {
      const covered = entries.every((pkg) => cache.entries[keyOf(pkg)] !== undefined);
      if (!covered) {
        throw new PilotError("Не удалось получить данные об уязвимостях из OSV", {
          hint: `${error instanceof Error ? error.message : String(error)}. Проверьте сеть или запустите с --offline после успешного аудита.`,
          exitCode: 2,
        });
      }
      staleAnswer = true;
    }
  }

  const vulnerabilities = entries.flatMap((pkg) => cache.entries[keyOf(pkg)]?.vulns ?? []);
  const checked = entries.filter((pkg) => cache.entries[keyOf(pkg)] !== undefined).length;

  if (options.offline && checked === 0 && entries.length > 0) {
    throw new PilotError("Кеш OSV пуст", {
      hint: "Запустите аудит без --offline хотя бы один раз, чтобы получить данные.",
      exitCode: 2,
    });
  }

  return {
    checked,
    unchecked: entries.length - checked,
    vulnerabilities,
    online,
    stale: staleAnswer,
    cachePath: existsSync(cachePath) ? cachePath : null,
  };
}

export function severityAtLeast(value: VulnSeverity, threshold: VulnSeverity): boolean {
  return SEVERITY_WEIGHT[value] >= SEVERITY_WEIGHT[threshold] && SEVERITY_WEIGHT[value] > 0;
}

export function renderVulnerabilities(result: OsvAuditResult): string {
  const lines = [
    `OSV: проверено ${String(result.checked)} из ${String(result.checked + result.unchecked)} пакетов, уязвимостей ${String(result.vulnerabilities.length)}.`,
  ];
  if (result.unchecked > 0) lines.push(`Без проверки: ${String(result.unchecked)} (нет в кеше).`);
  if (result.stale) lines.push("Данные OSV устарели: сеть недоступна, использован кеш.");
  if (result.vulnerabilities.length === 0) return `${lines.join("\n")}\n`;

  const sorted = [...result.vulnerabilities].sort((a, b) => {
    const weight = SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity];
    if (weight !== 0) return weight;
    return `${a.package}@${a.version}`.localeCompare(`${b.package}@${b.version}`);
  });
  lines.push("Уязвимости:");
  for (const vuln of sorted) {
    const fixed = vuln.fixed.length > 0 ? ` (исправлено в ${vuln.fixed.join(", ")})` : "";
    lines.push(`${vuln.severity.toUpperCase().padEnd(8)} ${vuln.id} ${vuln.package}@${vuln.version} — ${vuln.summary}${fixed}`);
  }
  return `${lines.join("\n")}\n`;
}
