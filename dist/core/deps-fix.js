/**
 * Dependency fix: turns the safe half of the `deps` audit into edits of
 * package.json. Only mechanical moves are applied — test-only packages go to
 * devDependencies, phantom imports get the version npm already installed, and
 * floating ranges are pinned to the lockfile version. Anything that needs a
 * human decision (removing a package, picking between duplicates, replacing a
 * git dependency) is reported as skipped instead of guessed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readLockfile } from "./lockfile.js";
import { isTestFile } from "./slop/source.js";
function readJson(path) {
    try {
        return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
    }
    catch {
        return undefined;
    }
}
/** Versions the package manager already resolved: the only versions safe to write back offline. */
function lockVersions(cwd) {
    return readLockfile(cwd)?.versions ?? new Map();
}
function take(record, name) {
    if (!record || !(name in record))
        return undefined;
    const spec = record[name];
    delete record[name];
    return spec;
}
function put(manifest, field, name, spec) {
    const record = manifest[field] ?? {};
    record[name] = spec;
    manifest[field] = record;
}
/** Produces package.json edits for the issues that have exactly one right answer. */
export function planDependencyFixes(cwd, audit) {
    const manifestPath = join(cwd, "package.json");
    const before = readFileSync(manifestPath, "utf8");
    const parsed = readJson(manifestPath);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { fixes: [], skipped: [], before, after: before };
    }
    const manifest = parsed;
    const versions = lockVersions(cwd);
    const fixes = [];
    const skipped = [];
    const handled = new Set();
    for (const issue of audit.issues) {
        if (handled.has(issue.name))
            continue;
        if (issue.kind === "misplaced") {
            const spec = take(manifest.dependencies, issue.name) ?? take(manifest.optionalDependencies, issue.name);
            if (spec === undefined)
                continue;
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
                    reason: "нет версии в lockfile — добавьте зависимость вручную",
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
                    reason: "нет версии в lockfile — зафиксируйте диапазон вручную",
                });
                continue;
            }
            const fields = ["dependencies", "devDependencies", "optionalDependencies"];
            const field = fields.find((candidate) => issue.name in (manifest[candidate] ?? {}));
            if (!field)
                continue;
            const previous = manifest[field]?.[issue.name] ?? "";
            manifest[field][issue.name] = `^${version}`;
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
        for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
            const record = manifest[field];
            if (record && Object.keys(record).length === 0)
                delete manifest[field];
        }
    }
    const after = fixes.length > 0 ? `${JSON.stringify(manifest, null, 2)}\n` : before;
    return { fixes, skipped, before, after };
}
/** Writes the plan; returns false when there was nothing to write. */
export function applyDependencyFixPlan(cwd, plan) {
    if (plan.fixes.length === 0)
        return false;
    writeFileSync(join(cwd, "package.json"), plan.after, "utf8");
    return true;
}
//# sourceMappingURL=deps-fix.js.map