import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PilotError } from "./errors.js";
import { getRepoRoot, runGit } from "./git.js";

export const SNAPSHOT_VERSION = 1;
const MAX_UNTRACKED_BYTES = 8 * 1024 * 1024;

export interface SnapshotInfo {
  id: string;
  path: string;
  head: string;
  createdAt: string;
  untrackedCount: number;
  tracked: boolean;
}

export interface SnapshotMeta {
  version: number;
  id: string;
  createdAt: string;
  head: string;
  repoRoot: string;
  untracked: string[];
}

function gitDir(repoRoot: string): string {
  const result = runGit(["rev-parse", "--git-dir"], repoRoot);
  if (result.status !== 0) {
    throw new PilotError("Не удалось определить git-dir репозитория", { hint: result.stderr });
  }
  const value = result.stdout.trim();
  return isAbsoluteLike(value) ? value : resolve(repoRoot, value);
}

function isAbsoluteLike(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(value);
}

function hasHead(repoRoot: string): boolean {
  return runGit(["rev-parse", "--verify", "HEAD"], repoRoot).status === 0;
}

function snapshotsRoot(repoRoot: string): string {
  return join(gitDir(repoRoot), "oc-pilot", "snapshots");
}

function newSnapshotId(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
  ].join("") + "-" + [pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())].join("");
  const random = Math.random().toString(16).slice(2, 6);
  return `${stamp}-${random}`;
}

/**
 * Creates a local working-tree snapshot under .git/oc-pilot/snapshots/<id>/:
 * a binary patch of tracked changes versus HEAD plus copies of untracked files.
 * Nothing is committed and nothing leaves the repository.
 */
export function createSnapshot(cwd: string): SnapshotInfo {
  const repoRoot = getRepoRoot(cwd);
  if (!hasHead(repoRoot)) {
    throw new PilotError("Снимок требует хотя бы одного коммита (HEAD отсутствует)", {
      hint: "Сделайте первый коммит или запускайте fix без --apply.",
      exitCode: 2,
    });
  }

  const head = runGit(["rev-parse", "HEAD"], repoRoot).stdout.trim();
  const patchResult = runGit(["diff", "--binary", "HEAD"], repoRoot);
  if (patchResult.status !== 0) {
    throw new PilotError("Не удалось снять diff рабочего дерева", { hint: patchResult.stderr });
  }
  const trackedPatch = patchResult.stdout;

  const list = runGit(["ls-files", "--others", "--exclude-standard", "--full-name", "-z"], repoRoot);
  if (list.status !== 0) {
    throw new PilotError("Не удалось получить список untracked-файлов", { hint: list.stderr });
  }
  const untracked = list.stdout.split("\0").filter(Boolean).map((file) => file.replace(/\\/g, "/"));

  const id = newSnapshotId();
  const dir = join(snapshotsRoot(repoRoot), id);
  const untrackedDir = join(dir, "untracked");
  mkdirSync(untrackedDir, { recursive: true });

  writeFileSync(join(dir, "tracked.patch"), trackedPatch, "utf8");

  let copied = 0;
  for (const file of untracked) {
    const absolute = join(repoRoot, file);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
    if (statSync(absolute).size > MAX_UNTRACKED_BYTES) continue;
    const target = join(untrackedDir, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(absolute, target);
    copied += 1;
  }

  const meta: SnapshotMeta = {
    version: SNAPSHOT_VERSION,
    id,
    createdAt: new Date().toISOString(),
    head,
    repoRoot,
    untracked,
  };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");

  return {
    id,
    path: dir,
    head,
    createdAt: meta.createdAt,
    untrackedCount: copied,
    tracked: trackedPatch.trim().length > 0,
  };
}

function readMeta(dir: string): SnapshotMeta {
  const metaPath = join(dir, "meta.json");
  if (!existsSync(metaPath)) {
    throw new PilotError(`Повреждённый снимок: нет meta.json (${dir})`);
  }
  try {
    return JSON.parse(readFileSync(metaPath, "utf8")) as SnapshotMeta;
  } catch {
    throw new PilotError(`Не удалось прочитать meta.json снимка (${dir})`);
  }
}

export function listSnapshots(cwd: string): SnapshotInfo[] {
  const repoRoot = getRepoRoot(cwd);
  const root = snapshotsRoot(repoRoot);
  if (!existsSync(root)) return [];
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const snapshots: SnapshotInfo[] = [];
  for (const id of entries) {
    const dir = join(root, id);
    try {
      const meta = readMeta(dir);
      snapshots.push({
        id: meta.id,
        path: dir,
        head: meta.head,
        createdAt: meta.createdAt,
        untrackedCount: meta.untracked.length,
        tracked: existsSync(join(dir, "tracked.patch")),
      });
    } catch {
      // Skip damaged snapshot directories when listing.
    }
  }
  return snapshots;
}

/**
 * Restores the working tree from a snapshot: resets tracked files to the
 * snapshotted state (HEAD + saved binary patch), then copies back saved
 * untracked files. The staged/unstaged split is not preserved. Files created
 * after the snapshot are never deleted.
 */
export function restoreSnapshot(cwd: string, id?: string): SnapshotInfo {
  const repoRoot = getRepoRoot(cwd);
  const root = snapshotsRoot(repoRoot);
  if (!existsSync(root)) {
    throw new PilotError("Снимков нет", { hint: "Снимок создаётся автоматически при oc-pilot fix --apply." });
  }

  let dir: string;
  if (id) {
    dir = join(root, id);
    if (!existsSync(dir)) {
      throw new PilotError(`Снимок не найден: ${id}`, {
        hint: "Список снимков: oc-pilot restore --list",
        exitCode: 2,
      });
    }
  } else {
    const snapshots = listSnapshots(cwd);
    if (snapshots.length === 0) {
      throw new PilotError("Снимков нет", { hint: "Снимок создаётся автоматически при oc-pilot fix --apply." });
    }
    dir = snapshots[snapshots.length - 1]!.path;
  }

  const meta = readMeta(dir);

  const currentHead = runGit(["rev-parse", "HEAD"], repoRoot).stdout.trim();
  if (currentHead !== meta.head) {
    throw new PilotError("HEAD сместился после снимка; восстановление небезопасно", {
      hint: "Закоммитьте или сделайте stash текущих изменений, затем повторите.",
      exitCode: 2,
    });
  }

  const reset = runGit(["reset", "--hard", "HEAD"], repoRoot);
  if (reset.status !== 0) {
    throw new PilotError("git reset --hard завершился с ошибкой", { hint: reset.stderr });
  }

  const patchPath = join(dir, "tracked.patch");
  const patch = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : "";
  if (patch.trim()) {
    const applied = runGit(["apply", "--binary", "--whitespace=nowarn"], repoRoot, patch);
    if (applied.status !== 0) {
      throw new PilotError("Не удалось применить снимок к рабочему дереву", {
        hint: applied.stderr || "Рабочее дерево сброшено к HEAD; снимок сохранён.",
      });
    }
  }

  let restoredUntracked = 0;
  for (const file of meta.untracked) {
    const source = join(dir, "untracked", file);
    if (!existsSync(source)) continue;
    const target = join(repoRoot, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    restoredUntracked += 1;
  }

  return {
    id: meta.id,
    path: dir,
    head: meta.head,
    createdAt: meta.createdAt,
    untrackedCount: restoredUntracked,
    tracked: patch.trim().length > 0,
  };
}

