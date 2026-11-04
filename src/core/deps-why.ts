/**
 * Dependency provenance: answers "why is this package here?" from local data only.
 * Combines the manifest, the imports in the code and the lockfile graph, so an
 * agent can see direct imports, every dependent package and the chains that pull
 * a transitive dependency in. Offline and deterministic.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { packageNameOf, type DepField } from "./deps-health.js";
import { PilotError } from "./errors.js";
import { readLockfile } from "./lockfile.js";
import { readRepository } from "./slop/collect.js";

export interface DependencyWhy {
  name: string;
  versions: string[];
  copies: number;
  declared: { field: DepField; spec: string } | null;
  importedBy: string[];
  dependents: string[];
  chains: string[][];
}

export interface DependencyWhyOptions {
  /** How many root-to-package chains to show. Default 5. */
  maxChains?: number;
  /** Maximum chain length in packages. Default 10. */
  maxDepth?: number;
}

interface PackageManifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  [key: string]: unknown;
}

interface LockNode {
  name: string;
  version?: string;
  deps: Record<string, string>;
}

const IMPORT_PATTERNS = [
  /\bfrom\s+["']([^"']+)["']/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\s+["']([^"']+)["']/g,
];

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return undefined;
  }
}

function recordOf(value: unknown): Record<string, string> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, string>) : {};
}

function manifestFields(manifest: PackageManifest): Array<[DepField, Record<string, string>]> {
  return [
    ["prod", recordOf(manifest.dependencies)],
    ["dev", recordOf(manifest.devDependencies)],
    ["optional", recordOf(manifest.optionalDependencies)],
    ["peer", recordOf(manifest.peerDependencies)],
  ];
}

function readManifest(cwd: string): PackageManifest {
  const path = join(cwd, "package.json");
  if (!existsSync(path)) {
    throw new PilotError("package.json не найден", {
      hint: "Запустите команду в корне npm-проекта или укажите --cwd.",
      exitCode: 2,
    });
  }
  const parsed = readJsonFile(path);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PilotError("Не удалось прочитать package.json", {
      hint: "Проверьте, что файл содержит корректный JSON.",
      exitCode: 2,
    });
  }
  return parsed as PackageManifest;
}

function nameFromKey(key: string): string | undefined {
  const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key);
  return match?.[1];
}

function loadV1(deps: Record<string, unknown> | undefined, parentKey: string, nodes: Map<string, LockNode>): void {
  for (const [name, raw] of Object.entries(deps ?? {})) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as { version?: unknown; dependencies?: Record<string, unknown> };
    const key = parentKey ? `${parentKey}/node_modules/${name}` : `node_modules/${name}`;
    nodes.set(key, {
      name,
      version: typeof entry.version === "string" ? entry.version : undefined,
      deps: recordOf(entry.dependencies),
    });
    loadV1(entry.dependencies, key, nodes);
  }
}

function lockNodes(lock: unknown): Map<string, LockNode> {
  const nodes = new Map<string, LockNode>();
  if (!lock || typeof lock !== "object") return nodes;
  const packages = (lock as { packages?: unknown }).packages;
  if (packages && typeof packages === "object" && !Array.isArray(packages)) {
    for (const [key, raw] of Object.entries(packages as Record<string, unknown>)) {
      if (!key || !raw || typeof raw !== "object") continue;
      const name = nameFromKey(key);
      if (!name) continue;
      const entry = raw as { version?: unknown; dependencies?: Record<string, unknown>; optionalDependencies?: Record<string, unknown> };
      nodes.set(key, {
        name,
        version: typeof entry.version === "string" ? entry.version : undefined,
        deps: { ...recordOf(entry.dependencies), ...recordOf(entry.optionalDependencies) },
      });
    }
    return nodes;
  }
  loadV1((lock as { dependencies?: Record<string, unknown> }).dependencies, "", nodes);
  return nodes;
}

/** pnpm and yarn lockfiles list every resolved package by name, without nesting. */
function flatNodes(packages: Array<{ name: string; version?: string; deps: Record<string, string> }>): Map<string, LockNode> {
  const nodes = new Map<string, LockNode>();
  for (const entry of packages) {
    if (!nodes.has(entry.name)) {
      nodes.set(entry.name, { name: entry.name, version: entry.version, deps: entry.deps });
    }
  }
  return nodes;
}

/** npm resolution: nested copy first, then walk up to the root node_modules. */
function resolveKey(nodes: Map<string, LockNode>, fromKey: string, dep: string): string | undefined {
  // Flat lockfiles (pnpm, yarn) are keyed by package name.
  if (nodes.has(dep)) return dep;
  let current = fromKey;
  while (current) {
    const candidate = `${current}/node_modules/${dep}`;
    if (nodes.has(candidate)) return candidate;
    const index = current.lastIndexOf("/node_modules/");
    if (index <= 0) break;
    current = current.slice(0, index);
  }
  const root = `node_modules/${dep}`;
  return nodes.has(root) ? root : undefined;
}

function rootDependencies(manifest: PackageManifest): string[] {
  const names = new Set<string>();
  for (const [, record] of manifestFields(manifest)) {
    for (const name of Object.keys(record)) names.add(name);
  }
  return [...names];
}

function collectChains(
  nodes: Map<string, LockNode>,
  roots: string[],
  target: string,
  maxChains: number,
  maxDepth: number,
): string[][] {
  const chains: string[][] = [];
  const queue: Array<{ key: string; path: string[] }> = [];
  for (const dep of roots) {
    const key = resolveKey(nodes, "", dep);
    if (!key) continue;
    const node = nodes.get(key)!;
    queue.push({ key, path: [node.name] });
  }

  while (queue.length > 0 && chains.length < maxChains) {
    const item = queue.shift()!;
    const node = nodes.get(item.key)!;
    if (node.name === target) {
      chains.push(item.path);
      continue;
    }
    if (item.path.length >= maxDepth) continue;
    for (const dep of Object.keys(node.deps)) {
      const childKey = resolveKey(nodes, item.key, dep);
      if (!childKey) continue;
      const child = nodes.get(childKey)!;
      if (item.path.includes(child.name)) continue;
      queue.push({ key: childKey, path: [...item.path, child.name] });
    }
  }

  return chains;
}

function importedBy(cwd: string, name: string): string[] {
  const files = readRepository(cwd).files;
  const paths = new Set<string>();
  for (const file of files) {
    for (const pattern of IMPORT_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(file.text)) !== null) {
        if (packageNameOf(match[1] ?? "") === name) {
          paths.add(file.path);
          break;
        }
      }
      if (paths.has(file.path)) break;
    }
  }
  return [...paths].sort();
}

/**
 * Explains where a package comes from. Returns undefined when the name appears
 * nowhere: not declared, not imported and not installed per the lockfile.
 */
export function explainDependency(
  cwd: string,
  name: string,
  options: DependencyWhyOptions = {},
): DependencyWhy | undefined {
  const packageName = name.trim();
  if (!packageName) throw new PilotError("Не указано имя пакета для --why", { exitCode: 2 });

  const manifest = readManifest(cwd);
  const declaredEntry = manifestFields(manifest)
    .map(([field, record]) => ({ field, spec: record[packageName] }))
    .find((entry) => entry.spec !== undefined);

  const lock = readLockfile(cwd);
  const npmNodes = lock?.kind === "npm" ? lockNodes(readJsonFile(join(cwd, lock.file))) : undefined;
  const nodes = npmNodes ?? flatNodes(lock?.packages ?? []);
  const installed: LockNode[] = npmNodes
    ? [...npmNodes.values()].filter((node) => node.name === packageName)
    : (lock?.packages ?? [])
        .filter((entry) => entry.name === packageName)
        .map((entry) => ({ name: entry.name, version: entry.version, deps: entry.deps }));
  const imports = importedBy(cwd, packageName);

  if (!declaredEntry && installed.length === 0 && imports.length === 0) return undefined;

  const versions = [...new Set(installed.map((node) => node.version).filter((value): value is string => Boolean(value)))].sort();

  const dependents = new Set<string>();
  for (const [, node] of nodes) {
    if (node.name === packageName) continue;
    if (Object.keys(node.deps).includes(packageName)) dependents.add(node.name);
  }

  const roots = rootDependencies(manifest);
  const chains =
    installed.length > 0
      ? collectChains(nodes, roots, packageName, options.maxChains ?? 5, options.maxDepth ?? 10)
      : [];

  const declared = declaredEntry ? { field: declaredEntry.field, spec: declaredEntry.spec } : null;

  return {
    name: packageName,
    versions,
    copies: installed.length,
    declared,
    importedBy: imports,
    dependents: [...dependents].sort(),
    chains,
  };
}

/** Human-readable report for the terminal. */
export function renderDependencyWhy(result: DependencyWhy): string {
  const fields: Record<DepField, string> = {
    prod: "dependencies",
    dev: "devDependencies",
    optional: "optionalDependencies",
    peer: "peerDependencies",
  };
  const lines = [`Пакет: ${result.name}`];
  if (result.copies > 0) {
    const copies = result.copies === 1 ? "1 копия" : `${result.copies} копии`;
    lines.push(`Версии в lockfile: ${result.versions.join(", ") || "без версии"} (${copies})`);
  } else {
    lines.push("В lockfile не найден");
  }
  lines.push(
    result.declared
      ? `Объявлен: ${fields[result.declared.field]} ${result.declared.spec}`
      : "В package.json не объявлен",
  );
  lines.push(
    result.importedBy.length > 0 ? `Импортируется: ${result.importedBy.join(", ")}` : "Прямых импортов нет",
  );
  lines.push(result.dependents.length > 0 ? `Зависит от него: ${result.dependents.join(", ")}` : "Никто не зависит");
  if (result.chains.length > 0) {
    lines.push("Цепочки от корня:");
    for (const chain of result.chains) lines.push(`  ${chain.join(" → ")}`);
  } else {
    lines.push("Цепочки от корня: нет — из package.json пакет недостижим");
  }
  return `${lines.join("\n")}\n`;
}
