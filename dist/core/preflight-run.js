import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { auditDependencies } from "./deps-health.js";
import { authzFingerprint, loadFindingsBaseline, sastFingerprint } from "./findings-baseline.js";
import { log } from "./log.js";
import { buildPreflightReport, scopeDependencyIssues, } from "./preflight.js";
import { scanSource } from "./sast.js";
import { scanAuthzSource } from "./authz.js";
import { analyzeAgainst } from "./slop/index.js";
import { isCodeFile, isGeneratedPath } from "./slop/source.js";
import { detectHoneypotTriggers } from "./honeypot.js";
import { scanInjection } from "./injection.js";
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
    let sastBaseline = new Set();
    let authzBaseline = new Set();
    try {
        const baseline = loadFindingsBaseline(cwd);
        sastBaseline = new Set(baseline.baseline.sast);
        authzBaseline = new Set(baseline.baseline.authz);
    }
    catch (error) {
        log.warn(`Baseline не прочитан: ${error instanceof Error ? error.message : String(error)}`);
    }
    let sast = null;
    let sastSkip;
    if (!disabled.includes("sast")) {
        const files = data.changedFiles.filter((file) => isCodeFile(file) && !isGeneratedPath(file) && existsSync(join(cwd, file)));
        if (files.length === 0) {
            sastSkip = "нет изменённых файлов для анализа";
        }
        else {
            sast = [];
            for (const file of files) {
                const text = readFileSync(join(cwd, file), "utf8");
                sast.push(...scanSource(file, text).findings);
            }
            sast = sast.filter((finding) => !sastBaseline.has(sastFingerprint(finding)));
        }
    }
    let authz = null;
    let authzSkip;
    if (!disabled.includes("authz")) {
        const files = data.changedFiles.filter((file) => isCodeFile(file) && !isGeneratedPath(file) && existsSync(join(cwd, file)));
        if (files.length === 0) {
            authzSkip = "нет изменённых файлов для анализа";
        }
        else {
            authz = [];
            for (const file of files) {
                const text = readFileSync(join(cwd, file), "utf8");
                authz.push(...scanAuthzSource(file, text).findings);
            }
            authz = authz.filter((finding) => !authzBaseline.has(authzFingerprint(finding)));
        }
    }
    return buildPreflightReport({
        diff: { source: data.source, stats: data.stats },
        secrets: disabled.includes("secrets") ? null : data.findings,
        sast,
        sastSkip,
        authz,
        authzSkip,
        deps,
        depsSkip,
        weaknesses: disabled.includes("tests") ? null : analyzeTestWeakness(data.diff),
        slop,
        slopSkip,
        honeypot: disabled.includes("honeypot") ? null : detectHoneypotTriggers(cwd, data.diff, data.changedFiles),
        injection: disabled.includes("injection") ? null : scanInjection(cwd),
        disabled,
        depsGate: options.depsGate,
        sastGate: options.sastGate,
        authzGate: options.authzGate,
        maxSlopDelta: options.maxSlopDelta,
    });
}
//# sourceMappingURL=preflight-run.js.map