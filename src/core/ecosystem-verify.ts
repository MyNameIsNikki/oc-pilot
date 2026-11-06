/**
 * Ecosystem verification: catches invented APIs and package-slurping.
 *
 * Offline it checks that a named import exists in the installed package's
 * entry or type declarations. Online it checks the age and weekly downloads
 * of newly added npm packages, because a package that appeared yesterday and
 * has five downloads is a supply-chain risk, not a dependency.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { analyzeDependencyChanges } from "./deps.js";
import { packageNameOf } from "./deps-health.js";

export type EcosystemIssueKind =
  | "missing-export"
  | "missing-package"
  | "unresolved-entry"
  | "new-package"
  | "low-downloads"
  | "registry-unavailable";

export type EcosystemSeverity = "high" | "medium" | "low";

export interface EcosystemIssue {
  package: string;
  kind: EcosystemIssueKind;
  severity: EcosystemSeverity;
  detail: string;
  file?: string;
  line?: number;
}

export interface PackageCheck {
  name: string;
  installed: boolean;
  declared: boolean;
  entry?: string;
  imports: number;
  missingExports: string[];
}

export interface EcosystemVerifyReport {
  packages: PackageCheck[];
  issues: EcosystemIssue[];
  counts: { total: number; high: number; medium: number; low: number };
  status: "pass" | "warn" | "fail";
}

export interface EcosystemVerifyOptions {
  online?: boolean;
  minAgeDays?: number;
  minDownloads?: number;
  registryUrl?: string;
  downloadsUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const MAX_FILES = 200;
const MAX_FILE_BYTES = 1_000_000;
const MAX_ENTRY_FILES = 8;
const MAX_ENTRY_BYTES = 512_000;
const MAX_REGISTRY_PACKAGES = 10;
const SEVERITY_WEIGHT: Record<EcosystemSeverity, number> = { high: 3, medium: 2, low: 1 };

const NAMED_IMPORT = /\b(?:import|export)\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["']([^"']+)["']/g;

interface ImportUse {
  file: string;
  line: number;
  source: string;
  names: string[];
}

function readText(path: string, limit: number): string | undefined {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return undefined;
    if (statSync(path).size > limit) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function readJson(path: string): Record<string, unknown> | undefined {
  const text = readText(path, MAX_ENTRY_BYTES);
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === "\n") line += 1;
  }
  return line;
}

/** Named imports and re-exports in a source file, with their line numbers. */
export function namedImports(text: string, file: string): ImportUse[] {
  const found: ImportUse[] = [];
  NAMED_IMPORT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NAMED_IMPORT.exec(text)) !== null) {
    const names = (match[1] ?? "")
      .split(",")
      .map((part) => part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim() ?? "")
      .filter((name) => name && name !== "default");
    if (names.length === 0) continue;
    found.push({
      file,
      line: lineAt(text, match.index),
      source: match[2] ?? "",
      names,
    });
  }
  return found;
}

function declaredPackages(cwd: string): Set<string> {
  const manifest = readJson(join(cwd, "package.json"));
  const names = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const block = manifest?.[field];
    if (block && typeof block === "object" && !Array.isArray(block)) {
      for (const name of Object.keys(block)) names.add(name);
    }
  }
  return names;
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (value.startsWith("./") || value.startsWith("../")) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
}

/** Entry files worth reading for export names, relative to the package root. */
export function packageEntries(cwd: string, name: string): { dir: string; files: string[] } | undefined {
  const dir = join(cwd, "node_modules", ...name.split("/"));
  const manifest = readJson(join(dir, "package.json"));
  if (!manifest) return undefined;
  const candidates: string[] = [];
  for (const field of ["types", "typings", "module", "main"]) {
    const value = manifest[field];
    if (typeof value === "string") candidates.push(value);
  }
  collectStrings(manifest.exports, candidates);
  for (const fallback of ["index.d.ts", "index.d.mts", "index.d.cts", "index.js", "index.mjs", "index.cjs"]) {
    candidates.push(fallback);
  }
  const files = [...new Set(candidates)]
    .map((value) => value.replace(/^\.\//, ""))
    .filter((value) => value && !value.includes(".."))
    .filter((value) => existsSync(join(dir, value)))
    .slice(0, MAX_ENTRY_FILES);
  return { dir, files };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when the entry text exports the name or re-exports everything. */
export function hasExport(text: string, name: string): { found: boolean; wildcard: boolean } {
  if (/\bexport\s*\*/.test(text) || /\bmodule\.exports\s*=/.test(text) && !/\bmodule\.exports\.\w+/.test(text)) {
    return { found: false, wildcard: true };
  }
  const escaped = escapeRegExp(name);
  const patterns = [
    new RegExp(`\\bexport\\s+(?:declare\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|class|const|let|var|interface|type|enum)\\s+${escaped}\\b`),
    new RegExp(`\\bexport\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}`),
    new RegExp(`\\bexports\\.${escaped}\\b`),
    new RegExp(`\\bexports\\[\\s*["']${escaped}["']\\s*\\]`),
  ];
  return { found: patterns.some((pattern) => pattern.test(text)), wildcard: false };
}

function issueCounts(issues: EcosystemIssue[]): EcosystemVerifyReport["counts"] {
  return {
    total: issues.length,
    high: issues.filter((issue) => issue.severity === "high").length,
    medium: issues.filter((issue) => issue.severity === "medium").length,
    low: issues.filter((issue) => issue.severity === "low").length,
  };
}

function addIssue(issues: EcosystemIssue[], issue: EcosystemIssue): void {
  const duplicate = issues.some(
    (item) =>
      item.package === issue.package &&
      item.kind === issue.kind &&
      item.file === issue.file &&
      item.line === issue.line &&
      item.detail === issue.detail,
  );
  if (!duplicate) issues.push(issue);
}

async function registryIssues(
  diff: string,
  options: EcosystemVerifyOptions,
  issues: EcosystemIssue[],
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const minAgeDays = options.minAgeDays ?? 30;
  const minDownloads = options.minDownloads ?? 1000;
  const registry = (options.registryUrl ?? "https://registry.npmjs.org").replace(/\/$/, "");
  const downloads = (options.downloadsUrl ?? "https://api.npmjs.org/downloads/point/last-week").replace(/\/$/, "");
  const added = analyzeDependencyChanges(diff)
    .filter((finding) => finding.ecosystem === "npm" && finding.risks.includes("new dependency"))
    .slice(0, MAX_REGISTRY_PACKAGES);
  for (const dependency of added) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
      try {
        const metaResponse = await fetchImpl(`${registry}/${encodeURIComponent(dependency.name)}`, {
          signal: controller.signal,
        });
        if (!metaResponse.ok) throw new Error(`registry ${String(metaResponse.status)}`);
        const meta = (await metaResponse.json()) as { time?: { created?: string } };
        const created = meta.time?.created ? Date.parse(meta.time.created) : Number.NaN;
        if (Number.isFinite(created)) {
          const ageDays = Math.floor((Date.now() - created) / 86_400_000);
          if (ageDays < minAgeDays) {
            addIssue(issues, {
              package: dependency.name,
              kind: "new-package",
              severity: "high",
              detail: `пакет опубликован ${String(ageDays)} дн. назад (порог ${String(minAgeDays)})`,
              file: dependency.file,
            });
          }
        }
        const downloadResponse = await fetchImpl(`${downloads}/${encodeURIComponent(dependency.name)}`, {
          signal: controller.signal,
        });
        if (downloadResponse.ok) {
          const stats = (await downloadResponse.json()) as { downloads?: number };
          if (typeof stats.downloads === "number" && stats.downloads < minDownloads) {
            addIssue(issues, {
              package: dependency.name,
              kind: "low-downloads",
              severity: "medium",
              detail: `${String(stats.downloads)} загрузок за неделю (порог ${String(minDownloads)})`,
              file: dependency.file,
            });
          }
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      addIssue(issues, {
        package: dependency.name,
        kind: "registry-unavailable",
        severity: "low",
        detail: `не удалось проверить npm registry: ${error instanceof Error ? error.message : String(error)}`,
        file: dependency.file,
      });
    }
  }
}

export async function verifyEcosystem(
  cwd: string,
  diff: string,
  changedFiles: string[],
  options: EcosystemVerifyOptions = {},
): Promise<EcosystemVerifyReport> {
  const declared = declaredPackages(cwd);
  const uses = new Map<string, ImportUse[]>();
  for (const file of changedFiles.slice(0, MAX_FILES)) {
    if (!existsSync(join(cwd, file))) continue;
    const text = readText(join(cwd, file), MAX_FILE_BYTES);
    if (!text) continue;
    for (const use of namedImports(text, file)) {
      const name = packageNameOf(use.source);
      if (!name) continue;
      const list = uses.get(name) ?? [];
      list.push(use);
      uses.set(name, list);
    }
  }

  const issues: EcosystemIssue[] = [];
  const packages: PackageCheck[] = [];
  for (const [name, imports] of [...uses].sort(([left], [right]) => left.localeCompare(right))) {
    const entries = packageEntries(cwd, name);
    const isDeclared = declared.has(name);
    if (!entries) {
      packages.push({ name, installed: false, declared: isDeclared, imports: imports.length, missingExports: [] });
      if (!isDeclared) {
        for (const use of imports) {
          addIssue(issues, {
            package: name,
            kind: "missing-package",
            severity: "high",
            detail: `пакет не установлен и не объявлен в package.json — импорт выдуман`,
            file: use.file,
            line: use.line,
          });
        }
      }
      continue;
    }

    const entryText = entries.files
      .map((file) => readText(join(entries.dir, file), MAX_ENTRY_BYTES) ?? "")
      .join("\n");
    const missing = new Set<string>();
    let wildcard = false;
    if (!entryText.trim()) {
      addIssue(issues, {
        package: name,
        kind: "unresolved-entry",
        severity: "medium",
        detail: "не удалось прочитать entry или .d.ts пакета — экспорт не проверен",
      });
    } else {
      for (const use of imports) {
        for (const exported of use.names) {
          const check = hasExport(entryText, exported);
          if (check.wildcard) {
            wildcard = true;
            continue;
          }
          if (!check.found) {
            missing.add(exported);
            addIssue(issues, {
              package: name,
              kind: "missing-export",
              severity: "high",
              detail: `экспорт "${exported}" не найден в установленной версии пакета`,
              file: use.file,
              line: use.line,
            });
          }
        }
      }
    }
    packages.push({
      name,
      installed: true,
      declared: isDeclared,
      entry: entries.files[0],
      imports: imports.length,
      missingExports: [...missing].sort(),
    });
    if (wildcard && missing.size === 0) continue;
  }

  if (options.online) await registryIssues(diff, options, issues);

  const counts = issueCounts(issues);
  const status: EcosystemVerifyReport["status"] =
    counts.high > 0 ? "fail" : counts.total > 0 ? "warn" : "pass";
  return { packages, issues, counts, status };
}

export function ecosystemIssueFailsGate(issues: EcosystemIssue[], threshold: EcosystemSeverity): boolean {
  return issues.some((issue) => SEVERITY_WEIGHT[issue.severity] >= SEVERITY_WEIGHT[threshold]);
}

export function describeEcosystemIssues(issues: EcosystemIssue[]): string {
  if (issues.length === 0) return "Проблем экосистемы не найдено.";
  const lines = issues
    .slice(0, 10)
    .map((issue) => {
      const location = issue.file ? `${issue.file}${issue.line ? `:${String(issue.line)}` : ""}: ` : "";
      return `- ${location}[${issue.kind}] ${issue.package}: ${issue.detail}`;
    });
  if (issues.length > 10) lines.push(`- …и ещё ${String(issues.length - 10)}`);
  return lines.join("\n");
}
