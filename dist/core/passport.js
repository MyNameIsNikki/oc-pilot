import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { VERSION } from "../version.js";
import { PilotError } from "./errors.js";
import { runGit } from "./git.js";
export const PASSPORT_PATH = ".oc-pilot/passport.json";
const PASSPORT_VERSION = 1;
function sha256(data) {
    return createHash("sha256").update(data).digest("hex");
}
function canonical(value) {
    if (Array.isArray(value))
        return value.map((item) => canonical(item));
    if (value && typeof value === "object") {
        const source = value;
        const result = {};
        for (const key of Object.keys(source).sort())
            result[key] = canonical(source[key]);
        return result;
    }
    return value;
}
export function canonicalJson(value) {
    return JSON.stringify(canonical(value));
}
export function passportPath(cwd) {
    return join(cwd, ".oc-pilot", "passport.json");
}
function passportDigest(manifest) {
    return `sha256:${sha256(canonicalJson(manifest))}`;
}
function gitValue(args, cwd) {
    const result = runGit(args, cwd);
    if (result.status !== 0)
        return undefined;
    const value = result.stdout.trim();
    return value || undefined;
}
function gitLines(args, cwd) {
    const result = runGit(args, cwd);
    if (result.status !== 0)
        return undefined;
    return result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
}
function unique(values) {
    return [...new Set(values)];
}
function worktreeFiles(cwd, includeUntracked) {
    const tracked = gitLines(["diff", "--name-only", "HEAD"], cwd) ?? [];
    const untracked = includeUntracked
        ? (gitLines(["ls-files", "--others", "--exclude-standard"], cwd) ?? [])
        : [];
    return unique([...tracked, ...untracked]).filter((path) => !path.startsWith(".oc-pilot/"));
}
function commitFiles(cwd, ref) {
    return unique((gitLines(["show", "--name-only", "--format=", "--first-parent", ref], cwd) ?? []).filter((path) => path.length > 0));
}
function hashWorktreeFile(cwd, path) {
    try {
        const data = readFileSync(join(cwd, path));
        return { path, hash: `sha256:${sha256(data)}`, bytes: data.length };
    }
    catch {
        return { path, hash: "missing" };
    }
}
function hashCommitFile(cwd, ref, path) {
    const blob = gitValue(["rev-parse", `${ref}:${path}`], cwd);
    return { path, hash: blob ? `git:${blob}` : "missing" };
}
function verdictOf(checks) {
    if (checks.some((check) => check.status === "fail"))
        return "fail";
    if (checks.length === 0 || checks.some((check) => check.status === "warn"))
        return "warn";
    return "pass";
}
export function parsePassportCheck(raw) {
    const match = /^(.+?)=(pass|warn|fail|skip)$/i.exec(raw.trim());
    if (!match?.[1] || !match[2]) {
        throw new PilotError(`Некорректная проверка: ${raw}`, {
            hint: "Используйте name=pass|warn|fail|skip, например tests=pass.",
            exitCode: 2,
        });
    }
    return { name: match[1].trim(), status: match[2].toLowerCase() };
}
/** Creates and stores a provenance manifest for a commit or the current worktree. */
export function createPassport(cwd, options) {
    const mode = options.mode;
    const ref = options.ref?.trim();
    if (mode === "commit" && !ref) {
        throw new PilotError("Для commit-паспорта нужен --commit <ref>", {
            hint: "Например: oc-pilot passport write --commit HEAD.",
            exitCode: 2,
        });
    }
    const commit = gitValue(["rev-parse", mode === "commit" ? ref : "HEAD"], cwd);
    if (!commit) {
        throw new PilotError("Не удалось определить коммит", {
            hint: "Нужен git-репозиторий хотя бы с одним коммитом.",
            exitCode: 2,
        });
    }
    const tree = gitValue(["rev-parse", `${commit}^{tree}`], cwd);
    if (!tree) {
        throw new PilotError("Не удалось определить tree коммита", { exitCode: 2 });
    }
    const paths = mode === "commit" ? commitFiles(cwd, commit) : worktreeFiles(cwd, options.includeUntracked === true);
    const files = mode === "commit"
        ? paths.map((path) => hashCommitFile(cwd, commit, path))
        : paths.map((path) => hashWorktreeFile(cwd, path));
    const checks = options.checks ?? [];
    const base = {
        version: PASSPORT_VERSION,
        tool: "oc-pilot",
        toolVersion: VERSION,
        createdAt: new Date().toISOString(),
        mode,
        commit,
        tree,
        branch: gitValue(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
        dirty: mode === "worktree" ? files.length > 0 : false,
        agent: options.agent,
        model: options.model,
        promptHash: options.promptHash,
        files,
        checks,
        verdict: verdictOf(checks),
    };
    const manifest = { ...base, digest: passportDigest(base) };
    const path = passportPath(cwd);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return manifest;
}
export function readPassport(cwd) {
    const path = passportPath(cwd);
    if (!existsSync(path))
        return undefined;
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (parsed.version !== PASSPORT_VERSION ||
            typeof parsed.commit !== "string" ||
            typeof parsed.tree !== "string" ||
            typeof parsed.digest !== "string" ||
            (parsed.mode !== "commit" && parsed.mode !== "worktree") ||
            !Array.isArray(parsed.files) ||
            !Array.isArray(parsed.checks)) {
            return undefined;
        }
        const files = parsed.files.filter((file) => Boolean(file) && typeof file === "object" && typeof file.path === "string" && typeof file.hash === "string");
        if (files.length !== parsed.files.length)
            return undefined;
        const checks = parsed.checks.filter((check) => Boolean(check) &&
            typeof check === "object" &&
            typeof check.name === "string" &&
            ["pass", "warn", "fail", "skip"].includes(check.status));
        if (checks.length !== parsed.checks.length)
            return undefined;
        return { ...parsed, files, checks };
    }
    catch {
        return undefined;
    }
}
/** Re-hashes the recorded files and proves that the manifest is still current. */
export function verifyPassport(cwd) {
    const manifest = readPassport(cwd);
    if (!manifest) {
        const result = {
            status: "missing",
            summary: "[PASSPORT MISSING]: .oc-pilot/passport.json не найден или повреждён.",
            changed: [],
            content: "",
        };
        result.content = renderPassportVerify(result);
        return result;
    }
    const { digest, ...rest } = manifest;
    if (passportDigest(rest) !== digest) {
        const result = {
            status: "tampered",
            summary: "[PASSPORT TAMPERED]: digest манифеста не совпадает с содержимым.",
            changed: [],
            manifest,
            content: "",
        };
        result.content = renderPassportVerify(result);
        return result;
    }
    const changed = [];
    if (manifest.mode === "commit") {
        const tree = gitValue(["rev-parse", `${manifest.commit}^{tree}`], cwd);
        if (!tree || tree !== manifest.tree)
            changed.push("commit tree");
        for (const file of manifest.files) {
            if (hashCommitFile(cwd, manifest.commit, file.path).hash !== file.hash)
                changed.push(file.path);
        }
    }
    else {
        if (gitValue(["rev-parse", "HEAD"], cwd) !== manifest.commit)
            changed.push("HEAD");
        for (const file of manifest.files) {
            if (hashWorktreeFile(cwd, file.path).hash !== file.hash)
                changed.push(file.path);
        }
    }
    const status = changed.length > 0 ? "stale" : "valid";
    const summary = status === "valid"
        ? "[PASSPORT VALID]: файлы и коммит совпадают с манифестом."
        : `[PASSPORT STALE]: манифест устарел, изменилось: ${changed.slice(0, 5).join(", ")}.`;
    const result = {
        status,
        summary,
        changed: unique(changed),
        manifest,
        content: "",
    };
    result.content = renderPassportVerify(result);
    return result;
}
export function clearPassport(cwd) {
    const path = passportPath(cwd);
    if (!existsSync(path))
        return { removed: false };
    rmSync(path, { force: true });
    return { removed: true };
}
export function renderPassport(manifest) {
    const lines = [
        `Passport: ${manifest.verdict}`,
        `Mode: ${manifest.mode}`,
        `Commit: ${manifest.commit}`,
        `Tree: ${manifest.tree}`,
        manifest.branch ? `Branch: ${manifest.branch}` : "",
        `Dirty: ${manifest.dirty ? "yes" : "no"}`,
        manifest.agent ? `Agent: ${manifest.agent}` : "",
        manifest.model ? `Model: ${manifest.model}` : "",
        manifest.promptHash ? `Prompt: ${manifest.promptHash}` : "",
        `Files: ${String(manifest.files.length)}`,
    ].filter((line) => line.length > 0);
    for (const file of manifest.files.slice(0, 50)) {
        lines.push(`  ${file.hash} ${file.path}`);
    }
    if (manifest.files.length > 50)
        lines.push(`  ... ещё ${String(manifest.files.length - 50)}`);
    lines.push(`Checks: ${manifest.checks.length === 0 ? "нет" : manifest.checks.map((check) => `${check.name}=${check.status}`).join(", ")}`);
    lines.push(`Digest: ${manifest.digest}`);
    return `${lines.join("\n")}\n`;
}
export function renderPassportMarkdown(manifest) {
    const checks = manifest.checks.length === 0
        ? "нет"
        : manifest.checks.map((check) => `\`${check.name}\` ${check.status}`).join(", ");
    return [
        "## oc-pilot passport",
        "",
        `- **Verdict:** ${manifest.verdict}`,
        `- **Mode:** ${manifest.mode}`,
        `- **Commit:** \`${manifest.commit}\``,
        `- **Tree:** \`${manifest.tree}\``,
        manifest.agent ? `- **Agent:** ${manifest.agent}` : "",
        manifest.model ? `- **Model:** ${manifest.model}` : "",
        `- **Files:** ${String(manifest.files.length)}`,
        `- **Checks:** ${checks}`,
        `- **Digest:** \`${manifest.digest}\``,
        "",
    ]
        .filter((line) => line.length > 0)
        .join("\n");
}
export function renderPassportVerify(result) {
    const lines = [`Passport: ${result.status}`, result.summary];
    if (result.manifest) {
        lines.push(`Commit: ${result.manifest.commit}`);
        lines.push(`Verdict: ${result.manifest.verdict}`);
        lines.push(`Files: ${String(result.manifest.files.length)}`);
    }
    if (result.changed.length > 0)
        lines.push(`Changed: ${result.changed.join(", ")}`);
    return `${lines.join("\n")}\n`;
}
//# sourceMappingURL=passport.js.map