/**
 * Lockfile abstraction: npm, pnpm and Yarn all answer the same question —
 * which versions are installed — but store it in three different formats.
 * `deps`, `deps --fix` and `deps --why` read this module instead of assuming
 * `package-lock.json`, so pnpm and Yarn projects are audited instead of being
 * silently reported as clean.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type LockfileKind = "npm" | "pnpm" | "yarn";

export interface LockfileInfo {
  kind: LockfileKind;
  /** File name, relative to the project root. */
  file: string;
  path: string;
}

export interface LockedPackage {
  name: string;
  version: string;
  deps: Record<string, string>;
}

export interface LockfileData extends LockfileInfo {
  /** Highest resolved version per package name. */
  versions: Map<string, string>;
  packages: LockedPackage[];
}

const LOCKFILES: Array<{ kind: LockfileKind; file: string }> = [
  { kind: "npm", file: "package-lock.json" },
  { kind: "pnpm", file: "pnpm-lock.yaml" },
  { kind: "yarn", file: "yarn.lock" },
];

const VERSION_HINT: Record<LockfileKind, string> = {
  npm: "npm ci упадёт",
  pnpm: "pnpm install --frozen-lockfile упадёт",
  yarn: "yarn install --immutable упадёт",
};

/** Human-readable consequence of a manifest/lockfile mismatch. */
export function lockfileHint(kind: LockfileKind): string {
  return VERSION_HINT[kind];
}

export function detectLockfile(cwd: string): LockfileInfo | undefined {
  for (const candidate of LOCKFILES) {
    const path = join(cwd, candidate.file);
    if (existsSync(path)) return { kind: candidate.kind, file: candidate.file, path };
  }
  return undefined;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return undefined;
  }
}

function readJson(path: string): unknown {
  const text = readText(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function recordOf(value: unknown): Record<string, string> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, string>) : {};
}

/** Crude semver-ish comparison: enough to pick the highest installed copy. */
export function compareVersions(a: string, b: string): number {
  const split = (value: string): { core: number[]; pre: string } => {
    const [core = "", ...rest] = value.split("-");
    return {
      core: core
        .split(".")
        .map((part) => Number.parseInt(part, 10))
        .map((part) => (Number.isFinite(part) ? part : 0)),
      pre: rest.join("-"),
    };
  };
  const left = split(a);
  const right = split(b);
  const length = Math.max(left.core.length, right.core.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (diff !== 0) return diff;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

function addVersion(versions: Map<string, string>, name: string, version: string): void {
  if (!name || !version) return;
  const current = versions.get(name);
  if (!current || compareVersions(version, current) > 0) versions.set(name, version);
}

/** npm: package-lock.json v2/v3 `packages`, or v1 `dependencies`. */
function parseNpm(cwd: string, file: string): LockedPackage[] {
  const lock = readJson(join(cwd, file));
  if (!lock || typeof lock !== "object") return [];
  const packages: LockedPackage[] = [];
  const root = lock as { packages?: unknown; dependencies?: unknown };
  if (root.packages && typeof root.packages === "object" && !Array.isArray(root.packages)) {
    for (const [key, raw] of Object.entries(root.packages as Record<string, unknown>)) {
      if (!key || !raw || typeof raw !== "object") continue;
      const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key);
      const name = match?.[1];
      if (!name) continue;
      const entry = raw as { version?: unknown; dependencies?: unknown; optionalDependencies?: unknown };
      if (typeof entry.version !== "string") continue;
      packages.push({
        name,
        version: entry.version,
        deps: { ...recordOf(entry.dependencies), ...recordOf(entry.optionalDependencies) },
      });
    }
    return packages;
  }

  const walk = (deps: unknown): void => {
    for (const [name, raw] of Object.entries(recordOf(deps))) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as { version?: unknown; dependencies?: unknown };
      if (typeof entry.version === "string") {
        packages.push({ name, version: entry.version, deps: recordOf(entry.dependencies) });
      }
      walk(entry.dependencies);
    }
  };
  walk(root.dependencies);
  return packages;
}

interface YamlEntry {
  key: string;
  lines: string[];
}

/** Splits a YAML document into top-level `section:` blocks with their lines. */
function yamlSections(text: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!line.startsWith(" ") && line.trimEnd().endsWith(":")) {
      current = line.trim().slice(0, -1);
      sections.set(current, []);
      continue;
    }
    if (current) sections.get(current)!.push(line);
  }
  return sections;
}

/** Splits an indented block into entries keyed by their (quoted) header. */
function yamlEntries(lines: string[], indent: number): YamlEntry[] {
  const entries: YamlEntry[] = [];
  let current: YamlEntry | undefined;
  for (const line of lines) {
    const spaces = line.length - line.trimStart().length;
    const header = line.trimEnd();
    if (spaces === indent && /:\s*(\{\})?$/.test(header)) {
      const key = header.replace(/:\s*(\{\})?$/, "").trim().replace(/^["']|["']$/g, "");
      current = { key, lines: [] };
      entries.push(current);
      continue;
    }
    if (current && spaces > indent) current.lines.push(line);
  }
  return entries;
}

/** Reads a `dependencies:` map nested inside an entry. */
function entryDeps(lines: string[], indent: number): Record<string, string> {
  const deps: Record<string, string> = {};
  let inside = false;
  for (const line of lines) {
    const spaces = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (spaces === indent && trimmed.endsWith(":")) {
      inside = trimmed === "dependencies:" || trimmed === "optionalDependencies:";
      continue;
    }
    if (!inside) continue;
    if (spaces <= indent) {
      inside = false;
      continue;
    }
    const match = /^([^\s:]+):\s*(.*)$/.exec(trimmed);
    if (match?.[1]) deps[match[1].replace(/^["']|["']$/g, "")] = match[2] ?? "";
  }
  return deps;
}

interface PnpmKey {
  name: string;
  version: string;
}

/** pnpm keys look like `/pkg@1.2.3`, `pkg@1.2.3(peer@1)` or legacy `/pkg/1.2.3`. */
function parsePnpmKey(raw: string): PnpmKey | undefined {
  let key = raw.trim().replace(/^\/+/, "");
  key = key.split("(")[0] ?? key;
  if (!key) return undefined;
  const at = key.lastIndexOf("@");
  if (at > 0) {
    const name = key.slice(0, at);
    const version = key.slice(at + 1);
    if (name && version && /^\d/.test(version)) return { name, version };
  }
  const slash = key.lastIndexOf("/");
  if (slash > 0) {
    const name = key.slice(0, slash);
    const version = key.slice(slash + 1);
    if (name && /^\d/.test(version)) return { name, version };
  }
  return undefined;
}

function parsePnpm(cwd: string, file: string): LockedPackage[] {
  const text = readText(join(cwd, file));
  if (text === undefined) return [];
  const sections = yamlSections(text);
  const packages: LockedPackage[] = [];
  const seen = new Set<string>();
  for (const section of ["snapshots", "packages"]) {
    const lines = sections.get(section);
    if (!lines) continue;
    for (const entry of yamlEntries(lines, 2)) {
      const parsed = parsePnpmKey(entry.key);
      if (!parsed) continue;
      const id = `${parsed.name}@${parsed.version}`;
      if (seen.has(id)) continue;
      seen.add(id);
      packages.push({ ...parsed, deps: entryDeps(entry.lines, 4) });
    }
  }
  return packages;
}

/** Yarn v1 and Berry share the `"pkg@range":` header shape. */
function parseYarn(cwd: string, file: string): LockedPackage[] {
  const text = readText(join(cwd, file));
  if (text === undefined) return [];
  const packages: LockedPackage[] = [];
  const blocks = text.split(/\r?\n(?=\S)/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const header = lines[0]?.trim();
    if (!header || header.startsWith("#") || !header.endsWith(":")) continue;
    const firstPattern = header.slice(0, -1).split(",")[0]?.trim().replace(/^["']|["']$/g, "");
    if (!firstPattern) continue;
    const at = firstPattern.startsWith("@") ? firstPattern.indexOf("@", 1) : firstPattern.indexOf("@");
    if (at <= 0) continue;
    const name = firstPattern.slice(0, at);
    let version = "";
    for (const line of lines.slice(1)) {
      const versionMatch = /^\s+version:?\s+"?([^"\s]+)"?/.exec(line);
      if (versionMatch?.[1]) {
        version = versionMatch[1];
        break;
      }
    }
    if (!version) continue;
    packages.push({ name, version, deps: entryDeps(lines.slice(1), 2) });
  }
  return packages;
}

/**
 * Reads the first lockfile present. Returns undefined when the project has
 * none, so callers can keep the "no lockfile means no lockfile check" rule.
 */
export function readLockfile(cwd: string): LockfileData | undefined {
  const info = detectLockfile(cwd);
  if (!info) return undefined;
  const packages =
    info.kind === "npm"
      ? parseNpm(cwd, info.file)
      : info.kind === "pnpm"
        ? parsePnpm(cwd, info.file)
        : parseYarn(cwd, info.file);
  const versions = new Map<string, string>();
  for (const entry of packages) addVersion(versions, entry.name, entry.version);
  return { ...info, packages, versions };
}
