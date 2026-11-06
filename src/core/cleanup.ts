import { applyDependencyFixPlan, planDependencyFixes } from "./deps-fix.js";
import { auditDependencies } from "./deps-health.js";
import { analyzeEnvSync } from "./env-sync.js";
import { analyzeRepository } from "./slop/index.js";
import { analyzeTestWeakness } from "./test-weakening.js";

export type CleanupSeverity = "high" | "medium" | "low";
export type CleanupKind = "deps" | "deps-fix" | "slop" | "env" | "tests";

export interface CleanupTask {
  id: string;
  kind: CleanupKind;
  severity: CleanupSeverity;
  summary: string;
  file?: string;
}

export interface CleanupPlan {
  tasks: CleanupTask[];
  counts: { total: number; high: number; medium: number; low: number };
  status: "pass" | "warn" | "fail";
}

const RANK: Record<CleanupSeverity, number> = { low: 1, medium: 2, high: 3 };

function count(tasks: CleanupTask[]): CleanupPlan["counts"] {
  return {
    total: tasks.length,
    high: tasks.filter((task) => task.severity === "high").length,
    medium: tasks.filter((task) => task.severity === "medium").length,
    low: tasks.filter((task) => task.severity === "low").length,
  };
}

/** Builds a prioritized offline cleanup plan from existing analyzers. */
export function buildCleanupPlan(cwd: string, diff: string): CleanupPlan {
  const tasks: CleanupTask[] = [];

  try {
    const audit = auditDependencies(cwd);
    for (const issue of audit.issues) {
      const severity: CleanupSeverity =
        issue.severity === "high" ? "high" : issue.severity === "medium" ? "medium" : "low";
      tasks.push({
        id: `deps:${issue.kind}:${issue.name}`,
        kind: "deps",
        severity,
        summary: `${issue.name}: ${issue.message}`,
      });
    }
    const fixPlan = planDependencyFixes(cwd, audit);
    for (const fix of fixPlan.fixes) {
      tasks.push({
        id: `deps-fix:${fix.name}:${fix.action}`,
        kind: "deps-fix",
        severity: "low",
        summary: `${fix.action}: ${fix.name}${fix.to ? ` -> ${fix.to}` : ""}`,
      });
    }
  } catch {
    // A repository without a package manager has no dependency tasks.
  }

  try {
    const slop = analyzeRepository(cwd, { blame: false });
    if (slop.index >= 40) {
      tasks.push({
        id: "slop:index",
        kind: "slop",
        severity: slop.index >= 70 ? "high" : "medium",
        summary: `Slop Index ${String(slop.index)}/100 (${slop.grade})`,
      });
    }
  } catch {
    // Slop needs git; skip it outside a repository.
  }

  try {
    const env = analyzeEnvSync(cwd, diff);
    for (const name of env.missing) {
      tasks.push({ id: `env:missing:${name}`, kind: "env", severity: "high", summary: `добавить ${name} в .env` });
    }
    for (const name of env.undocumented) {
      tasks.push({
        id: `env:undocumented:${name}`,
        kind: "env",
        severity: "medium",
        summary: `задокументировать ${name} в .env.example`,
      });
    }
  } catch {
    // Env parsing never throws in practice, but a cleanup plan must survive it.
  }

  for (const finding of analyzeTestWeakness(diff)) {
    tasks.push({
      id: `tests:${finding.kind}:${finding.file}:${String(finding.line)}`,
      kind: "tests",
      severity: "high",
      summary: `${finding.file}:${String(finding.line)} ${finding.kind}: ${finding.detail}`,
      file: finding.file,
    });
  }

  tasks.sort(
    (left, right) => RANK[right.severity] - RANK[left.severity] || left.id.localeCompare(right.id),
  );
  const counts = count(tasks);
  const status = counts.high > 0 ? "fail" : counts.total > 0 ? "warn" : "pass";
  return { tasks, counts, status };
}

/** Applies only the dependency fixes that are safe to write offline. */
export function applyCleanupPlan(cwd: string): { applied: boolean; fixed: number } {
  const audit = auditDependencies(cwd);
  const plan = planDependencyFixes(cwd, audit);
  if (plan.fixes.length === 0) return { applied: false, fixed: 0 };
  const applied = applyDependencyFixPlan(cwd, plan);
  return { applied, fixed: applied ? plan.fixes.length : 0 };
}

export function cleanupFailsGate(tasks: CleanupTask[], threshold: CleanupSeverity): boolean {
  return tasks.some((task) => RANK[task.severity] >= RANK[threshold]);
}

export function describeCleanup(plan: CleanupPlan): string {
  if (plan.tasks.length === 0) return "Задач для уборки не найдено.";
  const lines = plan.tasks.slice(0, 20).map((task) => `- [${task.severity}] ${task.summary}`);
  if (plan.tasks.length > 20) lines.push(`- …и ещё ${String(plan.tasks.length - 20)}`);
  return lines.join("\n");
}
