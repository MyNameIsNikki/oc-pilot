import { isAbsolute, resolve } from "node:path";
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
//# sourceMappingURL=hooks.js.map