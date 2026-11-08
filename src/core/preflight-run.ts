import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { auditDependencies, type DepSeverity } from "./deps-health.js";
import { authzFingerprint, loadFindingsBaseline, sastFingerprint } from "./findings-baseline.js";
import type { DiffData } from "./diff-source.js";
import { log } from "./log.js";
import {
  buildPreflightReport,
  scopeDependencyIssues,
  type PreflightCheckId,
  type PreflightReport,
} from "./preflight.js";
import { scanSource, type SastFinding, type SastSeverity } from "./sast.js";
import { scanAuthzSource, type AuthzFinding, type AuthzSeverity } from "./authz.js";
import { analyzeAgainst } from "./slop/index.js";
import { isCodeFile, isGeneratedPath } from "./slop/source.js";
import { detectHoneypotTriggers } from "./honeypot.js";
import { scanInjection } from "./injection.js";
import { analyzeTestWeakness } from "./test-weakening.js";

export interface CollectPreflightOptions {
  disabled?: PreflightCheckId[];
  depsGate?: DepSeverity;
  sastGate?: SastSeverity;
  authzGate?: AuthzSeverity;
  maxSlopDelta?: number;
  since?: string;
}

/**
 * Runs every offline preflight check against an already loaded diff.
 * Shared by the `preflight` and `receipt` commands so both report the same
 * verdict for the same working tree.
 */
export function collectPreflight(
  cwd: string,
  data: DiffData,
  options: CollectPreflightOptions = {},
): PreflightReport {
  const disabled = options.disabled ?? [];

  let deps: { audit: ReturnType<typeof auditDependencies>; issues: ReturnType<typeof scopeDependencyIssues> } | null = null;
  let depsSkip: string | undefined;
  if (!disabled.includes("deps")) {
    if (!existsSync(join(cwd, "package.json"))) {
      depsSkip = "package.json не найден";
    } else {
      const audit = auditDependencies(cwd);
      deps = { audit, issues: scopeDependencyIssues(audit.issues, data.changedFiles, data.diff) };
    }
  }

  let slop: { report: ReturnType<typeof analyzeAgainst>["current"]; delta: ReturnType<typeof analyzeAgainst>["delta"] } | null = null;
  let slopSkip: string | undefined;
  if (!disabled.includes("slop")) {
    const ref = options.since ?? "HEAD";
    try {
      const result = analyzeAgainst(cwd, ref, { blame: false, limit: 10 });
      slop = { report: result.current, delta: result.delta };
    } catch (error) {
      if (options.since !== undefined) throw error;
      slopSkip = `нет базы для сравнения (${ref})`;
      log.detail(`Дельта slop недоступна: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let sastBaseline = new Set<string>();
  let authzBaseline = new Set<string>();
  try {
    const baseline = loadFindingsBaseline(cwd);
    sastBaseline = new Set(baseline.baseline.sast);
    authzBaseline = new Set(baseline.baseline.authz);
  } catch (error) {
    log.warn(`Baseline не прочитан: ${error instanceof Error ? error.message : String(error)}`);
  }

  let sast: SastFinding[] | null = null;
  let sastSkip: string | undefined;
  if (!disabled.includes("sast")) {
    const files = data.changedFiles.filter(
      (file) => isCodeFile(file) && !isGeneratedPath(file) && existsSync(join(cwd, file)),
    );
    if (files.length === 0) {
      sastSkip = "нет изменённых файлов для анализа";
    } else {
      sast = [];
      for (const file of files) {
        const text = readFileSync(join(cwd, file), "utf8");
        sast.push(...scanSource(file, text).findings);
      }
      sast = sast.filter((finding) => !sastBaseline.has(sastFingerprint(finding)));
    }
  }

  let authz: AuthzFinding[] | null = null;
  let authzSkip: string | undefined;
  if (!disabled.includes("authz")) {
    const files = data.changedFiles.filter(
      (file) => isCodeFile(file) && !isGeneratedPath(file) && existsSync(join(cwd, file)),
    );
    if (files.length === 0) {
      authzSkip = "нет изменённых файлов для анализа";
    } else {
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
