import { spawnSync } from "node:child_process";
import type { AnalysisFinding } from "../types.js";
import { PilotError } from "./errors.js";
import { severityLabel } from "./findings.js";
import { VERSION } from "../version.js";

const MAX_COMMENT_FINDINGS = 30;

export interface PrCommentMeta {
  sha: string;
  knownHidden?: number;
}

/** Builds the markdown summary posted to the pull request. */
export function buildPrCommentBody(findings: AnalysisFinding[], meta: PrCommentMeta): string {
  const lines: string[] = ["## oc-pilot review", ""];

  if (findings.length === 0) {
    lines.push("No blocking findings. LGTM.", "");
  } else {
    const counts = {
      critical: findings.filter((finding) => finding.severity === "critical").length,
      warning: findings.filter((finding) => finding.severity === "warning").length,
      style: findings.filter((finding) => finding.severity === "style").length,
    };
    lines.push(`Findings: ${counts.critical} critical · ${counts.warning} warning · ${counts.style} style`, "");
    for (const finding of findings.slice(0, MAX_COMMENT_FINDINGS)) {
      const location = finding.location ? `\`${finding.location}\`` : "—";
      lines.push(`- [${severityLabel(finding.severity)}] ${location} — ${finding.text}`);
    }
    if (findings.length > MAX_COMMENT_FINDINGS) {
      lines.push(`- …and ${findings.length - MAX_COMMENT_FINDINGS} more`);
    }
    lines.push("");
  }

  if (meta.knownHidden && meta.knownHidden > 0) {
    lines.push(`${meta.knownHidden} finding(s) hidden by the project baseline (\`.oc-pilot/baseline.json\`).`, "");
  }

  lines.push(`---`, `oc-pilot v${VERSION} · commit ${meta.sha.slice(0, 12)}`);
  return `${lines.join("\n")}\n`;
}

function runGh(args: string[], cwd: string, input?: string) {
  try {
    return spawnSync("gh", args, {
      cwd,
      input,
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
    });
  } catch (error) {
    throw new PilotError("Не удалось запустить gh", {
      hint: `Установите GitHub CLI: https://cli.github.com (${error instanceof Error ? error.message : String(error)})`,
      exitCode: 1,
    });
  }
}

/**
 * Posts one summary comment on the pull request for the current branch.
 * Uses the gh CLI; GH_TOKEN / GITHUB_TOKEN in the environment is respected.
 */
export function postPrComment(body: string, cwd: string): void {
  const probe = runGh(["--version"], cwd);
  if (probe.error || probe.status !== 0) {
    throw new PilotError("GitHub CLI (gh) недоступен", {
      hint: "Установите gh и выполните `gh auth login` (https://cli.github.com).",
      exitCode: 1,
    });
  }

  const result = runGh(["pr", "comment", "--body-file", "-"], cwd, body);
  if (result.error || result.status !== 0) {
    throw new PilotError("Не удалось отправить комментарий в PR", {
      hint: `${(result.stderr || result.stdout || "").trim()}

Проверьте: ветка связана с PR (gh pr view), токен авторизован (gh auth status).`,
      exitCode: 1,
    });
  }
}
