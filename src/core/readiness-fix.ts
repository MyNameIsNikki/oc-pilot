import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { installHook } from "../commands/install-hook.js";
import { resolveHooksDir } from "./hooks.js";
import { detectTestCommand } from "./project.js";
import { type ReadinessReport } from "./readiness.js";

export type ReadinessFixAction = "install-hook" | "write-config" | "write-agents";

export interface ReadinessFix {
  action: ReadinessFixAction;
  path: string;
  reason: string;
}

export interface ReadinessSkip {
  check: string;
  reason: string;
}

export interface ReadinessFixPlan {
  fixes: ReadinessFix[];
  skipped: ReadinessSkip[];
}

const SKIP_REASONS: Record<string, string> = {
  tests: "нет тестовой команды — добавьте scripts.test в package.json",
  lockfile: "установите зависимости менеджером пакетов",
  slop: "энтропия кода исправляется вручную",
  security: "исправляется через oc-pilot fix --from-sast или --from-authz",
  receipt: "запустите oc-pilot receipt, чтобы получить квитанцию",
  ci: "CI настраивается вручную",
};

/**
 * Plans only the fixes that are safe to apply without network access and
 * without overwriting a file the project already owns.
 */
export function planReadinessFixes(cwd: string, report: ReadinessReport): ReadinessFixPlan {
  const fixes: ReadinessFix[] = [];
  const skipped: ReadinessSkip[] = [];

  for (const check of report.checks) {
    if (check.status === "pass") continue;

    if (check.id === "hooks") {
      let hookPath = join(cwd, ".git", "hooks", "pre-commit");
      try {
        hookPath = join(resolveHooksDir(cwd), "pre-commit");
      } catch {
        // Keep the default path when git cannot resolve the hooks directory.
      }
      if (existsSync(hookPath)) {
        const content = readFileSync(hookPath, "utf8");
        skipped.push({
          check: "hooks",
          reason: content.includes("# oc-pilot hook")
            ? "хук уже установлен, но preflight не проходит"
            : "чужой pre-commit не перезаписывается",
        });
      } else {
        fixes.push({
          action: "install-hook",
          path: hookPath,
          reason: "pre-commit будет запускать preflight --staged",
        });
      }
      continue;
    }

    if (check.id === "config") {
      fixes.push({
        action: "write-config",
        path: join(cwd, ".oc-pilot.json"),
        reason: "минимальный конфиг с тестовой командой",
      });
      continue;
    }

    if (check.id === "docs") {
      fixes.push({
        action: "write-agents",
        path: join(cwd, "AGENTS.md"),
        reason: "инструкции для агента с командами проекта",
      });
      continue;
    }

    skipped.push({ check: check.id, reason: SKIP_REASONS[check.id] ?? check.detail });
  }

  return { fixes, skipped };
}

function configText(cwd: string): string {
  const testCommand = detectTestCommand(cwd)?.command;
  const data = testCommand ? { testCommand } : {};
  return `${JSON.stringify(data, null, 2)}\n`;
}

function agentsText(cwd: string): string {
  const name = basename(cwd);
  const testCommand = detectTestCommand(cwd)?.command;
  return [
    "# AGENTS.md",
    "",
    "## Project",
    name,
    "",
    "## Commands",
    `- Tests: ${testCommand ? `\`${testCommand}\`` : "not configured yet"}`,
    "- Review the diff: `oc-pilot review --staged`",
    "- Gate before commit: `oc-pilot preflight --staged`",
    "- Prove the change: `oc-pilot receipt --staged`",
    "",
    "## Rules",
    "- Run the gate before reporting the work as done.",
    "- Do not lower a threshold or disable a check just to get a pass.",
    "- Keep the diff inside the task scope.",
    "",
  ].join("\n");
}

/** Applies a plan and returns the fixes that actually changed the repository. */
export function applyReadinessFixes(cwd: string, plan: ReadinessFixPlan): ReadinessFix[] {
  const applied: ReadinessFix[] = [];

  for (const fix of plan.fixes) {
    if (fix.action === "install-hook") {
      const result = installHook(cwd, "pre-commit", false, "preflight");
      applied.push({ ...fix, path: result.path });
      continue;
    }

    mkdirSync(dirname(fix.path), { recursive: true });
    writeFileSync(fix.path, fix.action === "write-config" ? configText(cwd) : agentsText(cwd), "utf8");
    applied.push(fix);
  }

  return applied;
}
