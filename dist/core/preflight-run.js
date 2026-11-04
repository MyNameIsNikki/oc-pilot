import { existsSync } from "node:fs";
import { join } from "node:path";
import { auditDependencies } from "./deps-health.js";
import { log } from "./log.js";
import { buildPreflightReport, scopeDependencyIssues, } from "./preflight.js";
import { analyzeAgainst } from "./slop/index.js";
import { analyzeTestWeakness } from "./test-weakening.js";
/**
 * Runs every offline preflight check against an already loaded diff.
 * Shared by the `preflight` and `receipt` commands so both report the same
 * verdict for the same working tree.
 */
export function collectPreflight(cwd, data, options = {}) {
    const disabled = options.disabled ?? [];
    let deps = null;
    let depsSkip;
    if (!disabled.includes("deps")) {
        if (!existsSync(join(cwd, "package.json"))) {
            depsSkip = "package.json не найден";
        }
        else {
            const audit = auditDependencies(cwd);
            deps = { audit, issues: scopeDependencyIssues(audit.issues, data.changedFiles, data.diff) };
        }
    }
    let slop = null;
    let slopSkip;
    if (!disabled.includes("slop")) {
        const ref = options.since ?? "HEAD";
        try {
            const result = analyzeAgainst(cwd, ref, { blame: false, limit: 10 });
            slop = { report: result.current, delta: result.delta };
        }
        catch (error) {
            if (options.since !== undefined)
                throw error;
            slopSkip = `нет базы для сравнения (${ref})`;
            log.detail(`Дельта slop недоступна: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return buildPreflightReport({
        diff: { source: data.source, stats: data.stats },
        secrets: disabled.includes("secrets") ? null : data.findings,
        deps,
        depsSkip,
        weaknesses: disabled.includes("tests") ? null : analyzeTestWeakness(data.diff),
        slop,
        slopSkip,
        disabled,
        depsGate: options.depsGate,
        maxSlopDelta: options.maxSlopDelta,
    });
}
//# sourceMappingURL=preflight-run.js.map