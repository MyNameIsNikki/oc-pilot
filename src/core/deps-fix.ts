/**
 * Dependency fix: turns the safe half of the `deps` audit into edits of
 * package.json. Only mechanical moves are applied — test-only packages go to
 * devDependencies, phantom imports get the version npm already installed, and
 * floating ranges are pinned to the lockfile version. Anything that needs a
 * human decision (removing a package, picking between duplicates, replacing a
 * git dependency) is reported as skipped instead of guessed.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DependencyAudit } from "./deps-health.js";
import { isTestFile } from "./slop/source.js";

export type DepFixAction = "move-to-dev" | "add-prod" | "add-dev" | "pin";

export interface DependencyFix {
  name: string;
  action: DepFixAction;
  from?: string;
  to?: string;
  reason: string;
}

export interface DependencySkip {
  name: string;
  kind: string;
  reason: string;
}

export interface DependencyFixPlan {
  /** Edits that will be written to package.json. */
  fixes: DependencyFix[];
  /** Issues the command refuses to fix automatically. */
  skipped: DependencySkip[];
  before: string;
  after: string;
}

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  [key: string]: unknown;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return undefined;
  }
}

/** Versions npm already resolved: the only versions safe to write back offline. */
function lockVersions(cwd: string): Map<string, string> {
  const versions = new Map<string, string>();
  const path = join(cwd, "package-lock.json");
  if (!existsSync(path)) return versions;
  const lock = readJson(path);
  if (!lock || typeof lock !== "object") return versions;

  const packages = (lock as { packages?: Record<string, { version?: string }> }).packages;
  if (packages && typeof packages === "object") {
    for (const [key, value] of Object.entries(packages)) {
      const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key);
      const version = value?.version;
      if (match?.[1] && typeof version === "string" && version) versions.set(match[1], version);
    }
    return versions;
  }

  const dependencies = (lock as { dependencies?: Record<string, { version?: string }> }).dependencies;
  for (const [name, value] of Object.entries(dependencies ?? {})) {
    if (typeof value?.version === "string" && value.version) versions.set(name, value.version);
  }
  return versions;
}

function take(record: Record<string, string> | undefined, name: string): string | undefined {
  if (!record || !(name in record)) return undefined;
  const spec = record[name];
  delete record[name];
  return spec;
}

function put(manifest: Manifest, field: "dependencies" | "devDependencies", name: string, spec: string): void {
  const record = manifest[field] ?? {};
  record[name] = spec;
  manifest[field] = record;
}

/** Produces package.json edits for the issues that have exactly one right answer. */
export function planDependencyFixes(cwd: string, audit: DependencyAudit): DependencyFixPlan {
  const manifestPath = join(cwd, "package.json");
  const before = readFileSync(manifestPath, "utf8");
  const parsed = readJson(manifestPath);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { fixes: [], skipped: [], before, after: before };
  }

  const manifest = parsed as Manifest;
  const versions = lockVersions(cwd);
  const fixes: DependencyFix[] = [];
  const skipped: DependencySkip[] = [];
  const handled = new Set<string>();

  for (const issue of audit.issues) {
    if (handled.has(issue.name)) continue;

    if (issue.kind === "misplaced") {
      const spec = take(manifest.dependencies, issue.name) ?? take(manifest.optionalDependencies, issue.name);
      if (spec === undefined) continue;
      put(manifest, "devDependencies", issue.name, spec);
      handled.add(issue.name);
      fixes.push({
        name: issue.name,
        action: "move-to-dev",
        from: `dependencies:${spec}`,
        to: `devDependencies:${spec}`,
        reason: "используется только в тестах",
      });
      continue;
    }

    if (issue.kind === "phantom") {
      const version = versions.get(issue.name);
      if (!version) {
        handled.add(issue.name);
        skipped.push({
          name: issue.name,
          kind: issue.kind,
          reason: "нет версии в package-lock.json — добавьте зависимость вручную",
        });
        continue;
      }
      const testOnly = (issue.files ?? []).length > 0 && (issue.files ?? []).every((file) => isTestFile(file));
      const field = testOnly ? "devDependencies" : "dependencies";
      put(manifest, field, issue.name, `^${version}`);
      handled.add(issue.name);
      fixes.push({
        name: issue.name,
        action: testOnly ? "add-dev" : "add-prod",
        to: `${field}:^${version}`,
        reason: `импортируется, версия ${version} уже в lockfile`,
      });
      continue;
    }

    if (issue.kind === "unpinned") {
      const version = versions.get(issue.name);
      if (!version) {
        handled.add(issue.name);
        skipped.push({
          name: issue.name,
          kind: issue.kind,
          reason: "нет версии в package-lock.json — зафиксируйте диапазон вручную",
        });
        continue;
      }
      const fields = ["dependencies", "devDependencies", "optionalDependencies"] as const;
      const field = fields.find((candidate) => issue.name in (manifest[candidate] ?? {}));
      if (!field) continue;
      const previous = manifest[field]?.[issue.name] ?? "";
      manifest[field]![issue.name] = `^${version}`;
      handled.add(issue.name);
      fixes.push({
        name: issue.name,
        action: "pin",
        from: previous,
        to: `^${version}`,
        reason: "версия взята из lockfile",
      });
      continue;
    }

    if (issue.kind === "lockfile") {
      handled.add(issue.name);
      skipped.push({
        name: issue.name,
        kind: issue.kind,
        reason: "исправляется только установкой: запустите npm install",
      });
      continue;
    }

    if (issue.kind === "unused") {
      handled.add(issue.name);
      skipped.push({
        name: issue.name,
        kind: issue.kind,
        reason: "удаление пакета требует решения — уберите вручную, если он не нужен",
      });
      continue;
    }

    if (issue.kind === "duplicate") {
      handled.add(issue.name);
      skipped.push({
        name: issue.name,
        kind: issue.kind,
        reason: "выберите один пакет вручную",
      });
      continue;
    }

    handled.add(issue.name);
    skipped.push({
      name: issue.name,
      kind: issue.kind,
      reason: "замените git/URL-зависимость на версию из реестра вручную",
    });
  }

  if (fixes.length > 0) {
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const) {
      const record = manifest[field];
      if (record && Object.keys(record).length === 0) delete manifest[field];
    }
  }
  const after = fixes.length > 0 ? `${JSON.stringify(manifest, null, 2)}\n` : before;
  return { fixes, skipped, before, after };
}

/** Writes the plan; returns false when there was nothing to write. */
export function applyDependencyFixPlan(cwd: string, plan: DependencyFixPlan): boolean {
  if (plan.fixes.length === 0) return false;
  writeFileSync(join(cwd, "package.json"), plan.after, "utf8");
  return true;
}
