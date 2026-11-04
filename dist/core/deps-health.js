/**
 * Dependency health: audits package.json against the imports the code actually
 * makes. Catches the clean-install breakers agents create: phantom imports of
 * transitive packages, declared-but-unused dependencies, test-only packages in
 * `dependencies`, overlapping libraries, unsafe specs and a lockfile that is
 * out of sync with the manifest. Everything is offline and deterministic.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PilotError } from "./errors.js";
import { detectLockfile, lockfileHint, readLockfile } from "./lockfile.js";
import { readRepository } from "./slop/collect.js";
import { isTestFile } from "./slop/source.js";
const NODE_BUILTINS = new Set([
    "assert",
    "async_hooks",
    "buffer",
    "child_process",
    "cluster",
    "console",
    "constants",
    "crypto",
    "dgram",
    "diagnostics_channel",
    "dns",
    "domain",
    "events",
    "fs",
    "http",
    "http2",
    "https",
    "inspector",
    "module",
    "net",
    "os",
    "path",
    "perf_hooks",
    "process",
    "punycode",
    "querystring",
    "readline",
    "repl",
    "string_decoder",
    "timers",
    "tls",
    "trace_events",
    "tty",
    "url",
    "util",
    "v8",
    "vm",
    "wasi",
    "worker_threads",
    "zlib",
]);
/** Injected by compilers and polyfills rather than imported by source. */
const TOOLING_PACKAGES = new Set(["tslib", "core-js", "regenerator-runtime", "@babel/runtime"]);
/** Libraries that solve the same task: keeping two of them is dependency slop. */
const OVERLAPS = [
    ["moment", "dayjs", "date-fns", "luxon"],
    ["lodash", "underscore", "ramda"],
    ["axios", "got", "node-fetch", "superagent", "undici"],
    ["jest", "vitest", "mocha", "ava", "tap"],
    ["eslint", "biome", "oxlint"],
    ["webpack", "vite", "rollup", "esbuild", "parcel"],
    ["express", "fastify", "koa", "hapi", "@hapi/hapi"],
    ["chalk", "kleur", "picocolors", "ansi-colors", "yoctocolors"],
    ["yargs", "commander", "meow", "cac", "minimist"],
    ["pg", "mysql2", "better-sqlite3", "sqlite3", "mongodb", "mongoose", "prisma", "sequelize", "drizzle-orm", "knex"],
];
const IMPORT_PATTERNS = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s+["']([^"']+)["']/g,
];
const SEVERITY_WEIGHT = { high: 3, medium: 2, low: 1 };
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** `@scope/pkg/sub` -> `@scope/pkg`, `pkg/sub` -> `pkg`; relative and builtin schemes -> undefined. */
export function packageNameOf(specifier) {
    const value = specifier.trim();
    if (!value)
        return undefined;
    if (value.startsWith(".") || value.startsWith("/") || value.startsWith("#"))
        return undefined;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value))
        return undefined;
    const parts = value.split("/");
    if (value.startsWith("@")) {
        return parts.length >= 2 && parts[1] ? `${parts[0]}/${parts[1]}` : undefined;
    }
    return parts[0] || undefined;
}
function importedPackages(text) {
    const found = new Set();
    for (const pattern of IMPORT_PATTERNS) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(text)) !== null) {
            const name = packageNameOf(match[1] ?? "");
            if (name)
                found.add(name);
        }
    }
    return [...found];
}
function readJsonFile(path) {
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
        return parsed;
    }
    catch {
        return undefined;
    }
}
function workspaceNames(cwd, manifest) {
    const patterns = Array.isArray(manifest.workspaces)
        ? manifest.workspaces
        : manifest.workspaces?.packages ?? [];
    const names = new Set();
    for (const pattern of patterns) {
        const normalized = pattern.replace(/\\/g, "/").replace(/\/+$/, "");
        if (!normalized.endsWith("/*"))
            continue;
        const base = join(cwd, normalized.slice(0, -2));
        if (!existsSync(base))
            continue;
        for (const entry of readdirSync(base)) {
            const child = readJsonFile(join(base, entry, "package.json"));
            if (!child || typeof child !== "object")
                continue;
            const name = child.name;
            if (name)
                names.add(name);
        }
    }
    return names;
}
/** Configuration blocks (`lint-staged`, `babel`, ...) name packages without importing them. */
function manifestExtras(manifest) {
    const extras = {};
    for (const [key, value] of Object.entries(manifest)) {
        if (/dependencies$/i.test(key) || key === "scripts" || key === "name")
            continue;
        extras[key] = value;
    }
    return JSON.stringify(extras);
}
function mentionedInScripts(scripts, name) {
    return new RegExp(`(?:^|[\\s"'/:=])${escapeRegExp(name)}(?:$|[\\s"'/:=])`).test(scripts);
}
function quotedAnywhere(files, name) {
    const pattern = new RegExp(`["'\`]${escapeRegExp(name)}(?:/[^"'\`\\s]*)?["'\`]`);
    return files.some((file) => pattern.test(file.text));
}
function isNpmProjectManifest(path) {
    return /(^|\/)package\.json$/.test(path.replace(/\\/g, "/"));
}
export function auditDependencies(cwd, options = {}) {
    const manifestPath = join(cwd, "package.json");
    if (!existsSync(manifestPath) || !isNpmProjectManifest(manifestPath)) {
        throw new PilotError("package.json не найден", {
            hint: "Запустите команду в корне npm-проекта или укажите --cwd.",
            exitCode: 2,
        });
    }
    const parsed = readJsonFile(manifestPath);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new PilotError("Не удалось прочитать package.json", {
            hint: "Проверьте, что файл содержит корректный JSON.",
            exitCode: 2,
        });
    }
    const manifest = parsed;
    const declared = new Map();
    const collect = (record, field, overwrite) => {
        for (const [name, spec] of Object.entries(record ?? {})) {
            if (overwrite || !declared.has(name))
                declared.set(name, { field, spec });
        }
    };
    collect(manifest.dependencies, "prod", true);
    collect(manifest.devDependencies, "dev", false);
    collect(manifest.peerDependencies, "peer", false);
    collect(manifest.optionalDependencies, "optional", true);
    const ignore = new Set(options.ignore ?? []);
    const repository = readRepository(cwd);
    const files = repository.files;
    const workspaces = workspaceNames(cwd, manifest);
    const skip = (name) => ignore.has(name) || name === manifest.name || workspaces.has(name);
    const usage = new Map();
    for (const file of files) {
        for (const name of importedPackages(file.text)) {
            const paths = usage.get(name) ?? [];
            if (!paths.includes(file.path))
                paths.push(file.path);
            usage.set(name, paths);
        }
    }
    const scripts = Object.values(manifest.scripts ?? {}).join("\n");
    const extras = manifestExtras(manifest);
    const issues = [];
    for (const [name, paths] of usage) {
        if (skip(name) || NODE_BUILTINS.has(name) || declared.has(name))
            continue;
        issues.push({
            kind: "phantom",
            severity: "high",
            name,
            files: paths.slice(0, 5),
            message: `импортируется в ${paths.length} файле(ах), но не объявлен в package.json — чистая установка упадёт`,
        });
    }
    for (const [name, info] of declared) {
        if (skip(name) || info.field === "peer")
            continue;
        if (name.startsWith("@types/") || TOOLING_PACKAGES.has(name))
            continue;
        if (usage.has(name) || quotedAnywhere(files, name))
            continue;
        if (mentionedInScripts(scripts, name) || mentionedInScripts(extras, name))
            continue;
        issues.push({
            kind: "unused",
            severity: "medium",
            name,
            message: "объявлен, но нигде не используется — можно удалить",
        });
    }
    for (const [name, info] of declared) {
        if (skip(name) || (info.field !== "prod" && info.field !== "optional"))
            continue;
        const paths = usage.get(name);
        if (!paths || paths.length === 0)
            continue;
        if (!paths.every((path) => isTestFile(path)))
            continue;
        issues.push({
            kind: "misplaced",
            severity: "low",
            name,
            files: paths.slice(0, 5),
            message: "используется только в тестах — перенесите в devDependencies",
        });
    }
    for (const group of OVERLAPS) {
        const present = group.filter((name) => declared.has(name));
        if (present.length < 2)
            continue;
        issues.push({
            kind: "duplicate",
            severity: "low",
            name: present.join(", "),
            message: `${present.length} пакета решают одну задачу — оставьте один`,
        });
    }
    for (const [name, info] of declared) {
        if (skip(name) || info.field === "peer")
            continue;
        const spec = info.spec.trim();
        if (!spec || spec === "*" || spec === "latest") {
            issues.push({
                kind: "unpinned",
                severity: "medium",
                name,
                message: `диапазон версии «${spec || "пусто"}» не фиксирует версию`,
            });
            continue;
        }
        if (spec.startsWith("workspace:"))
            continue;
        if (/^(git\+|github:|git@|https?:\/\/)/i.test(spec)) {
            issues.push({
                kind: "vcs",
                severity: "high",
                name,
                message: `зависимость подключена из ${spec} — код не проверен реестром`,
            });
        }
        else if (spec.startsWith("file:")) {
            issues.push({
                kind: "vcs",
                severity: "low",
                name,
                message: "локальная зависимость file: не попадёт в публикацию",
            });
        }
    }
    let lockfile = null;
    const lockInfo = detectLockfile(cwd);
    if (lockInfo) {
        lockfile = lockInfo.file;
        const lock = readLockfile(cwd);
        if (!lock || lock.packages.length === 0) {
            issues.push({
                kind: "lockfile",
                severity: "low",
                name: lockInfo.file,
                message: "не удалось прочитать lockfile — проверьте формат",
            });
        }
        else {
            const installed = new Set(lock.packages.map((entry) => entry.name));
            for (const [name, info] of declared) {
                if (skip(name) || info.field === "peer")
                    continue;
                if (/^(workspace:|file:)/.test(info.spec.trim()))
                    continue;
                if (installed.has(name))
                    continue;
                issues.push({
                    kind: "lockfile",
                    severity: "high",
                    name,
                    message: `объявлен в package.json, но отсутствует в ${lockInfo.file} — ${lockfileHint(lockInfo.kind)}`,
                });
            }
        }
    }
    const order = { high: 0, medium: 1, low: 2 };
    issues.sort((left, right) => order[left.severity] - order[right.severity] ||
        left.kind.localeCompare(right.kind) ||
        left.name.localeCompare(right.name));
    return {
        packageName: manifest.name ?? "(без имени)",
        declared: declared.size,
        imported: usage.size,
        scannedFiles: files.length,
        truncated: repository.truncated,
        lockfile,
        issues,
    };
}
/** Exit code helper: true when an issue is at least as severe as the threshold. */
export function issueFailsGate(issues, threshold) {
    const limit = SEVERITY_WEIGHT[threshold];
    return issues.some((issue) => SEVERITY_WEIGHT[issue.severity] >= limit);
}
//# sourceMappingURL=deps-health.js.map