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

export interface GithubCommentTarget {
  repo: string;
  issue: string;
  token: string;
  apiUrl: string;
}

/**
 * Detects "running inside a pull-request GitHub Actions job": in that case the
 * comment can be posted through the REST API with GITHUB_TOKEN — no gh CLI or
 * local auth needed.
 */
export function githubCommentTarget(env: NodeJS.ProcessEnv = process.env): GithubCommentTarget | undefined {
  if (env.GITHUB_ACTIONS !== "true") return undefined;
  const token = env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  const ref = env.GITHUB_REF ?? "";
  const pull = /^refs\/pull\/(\d+)\/(?:merge|head)$/.exec(ref);
  if (!token || !repo || !pull) return undefined;
  return { repo, issue: pull[1]!, token, apiUrl: env.GITHUB_API_URL ?? "https://api.github.com" };
}

async function postViaGithubApi(target: GithubCommentTarget, body: string): Promise<void> {
  const response = await fetch(`${target.apiUrl}/repos/${target.repo}/issues/${target.issue}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${target.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new PilotError("Не удалось отправить комментарий в PR (GitHub API)", {
      hint: `HTTP ${response.status} ${detail.slice(0, 300)}

Проверьте permissions: pull-requests: write у GITHUB_TOKEN.`,
      exitCode: 1,
    });
  }
}

/**
 * Posts one summary comment on the pull request for the current branch.
 * Inside a PR Actions job posts via the REST API with GITHUB_TOKEN;
 * everywhere else falls back to the gh CLI.
 */
export async function postPrComment(body: string, cwd: string): Promise<void> {
  const target = githubCommentTarget();
  if (target) {
    await postViaGithubApi(target, body);
    return;
  }

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
