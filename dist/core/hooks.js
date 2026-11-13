import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { PilotError } from "./errors.js";
import { runGit } from "./git.js";
/** Resolves the hooks directory honoring core.hooksPath and worktrees. */
export function resolveHooksDir(cwd) {
    const result = runGit(["rev-parse", "--git-path", "hooks"], cwd);
    if (result.status !== 0) {
        throw new PilotError("не удалось определить каталог git-хуков", {
            hint: result.stderr,
            exitCode: 2,
        });
    }
    const value = result.stdout.trim();
    return isAbsolute(value) ? value : resolve(cwd, value);
}
function isExecutableFile(path, platform) {
    try {
        if (!statSync(path).isFile())
            return false;
        if (platform !== "win32")
            accessSync(path, constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
function findOnPath(name, env, platform) {
    const pathValue = env.PATH ?? env.Path;
    if (!pathValue)
        return undefined;
    const separator = platform === "win32" ? ";" : delimiter;
    const extensions = platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
    for (const entry of pathValue.split(separator)) {
        const directory = entry.trim().replace(/^"(.*)"$/, "$1");
        if (!directory)
            continue;
        for (const extension of extensions) {
            const candidate = join(directory, `${name}${extension}`);
            if (isExecutableFile(candidate, platform))
                return candidate;
        }
    }
    return undefined;
}
/**
 * Finds the oc-pilot binary that a managed git hook will use. Mirrors the
 * hook script order: OC_PILOT_BIN, then the project-local binary, then PATH.
 */
export function resolveHookBinary(cwd, options = {}) {
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    const override = env.OC_PILOT_BIN?.trim();
    if (override) {
        const candidate = isAbsolute(override) ? override : resolve(cwd, override);
        if (isExecutableFile(candidate, platform))
            return candidate;
        return findOnPath(override, env, platform);
    }
    const local = join(cwd, "node_modules", ".bin", "oc-pilot");
    if (isExecutableFile(local, platform))
        return local;
    if (platform === "win32" && isExecutableFile(`${local}.cmd`, platform)) {
        return `${local}.cmd`;
    }
    return findOnPath("oc-pilot", env, platform);
}
//# sourceMappingURL=hooks.js.map