import type { AnalysisFinding } from "../types.js";
import { PilotError } from "./errors.js";
import { severityLabel } from "./findings.js";
import { log } from "./log.js";
import { githubCommentTarget, postPrComment, type GithubCommentTarget } from "./pr-comment.js";

const MAX_INLINE_COMMENTS = 25;
const LOCATION_RE = /^(.*?):(\d+)(?::\d+)?$/;

/** One inline review comment pinned to a line of the diff. */
export interface InlineComment {
  path: string;
  line: number;
  body: string;
}

/**
 * Collects the new-file line numbers GitHub accepts for inline comments: every
 * added or context line of every hunk. Commenting on a line outside these
 * ranges makes GitHub reject the whole review with 422, so findings are checked
 * against this map before they are sent.
 */
export function commentedDiffLines(diff: string): Map<string, Set<number>> {
  const lines = new Map<string, Set<number>>();
  let current: Set<number> | undefined;
  let line = 0;

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const target = raw.slice(4).trim();
      if (!target || target === "/dev/null") {
        current = undefined;
        continue;
      }
      const path = target.replace(/^b\//, "").replace(/\\/g, "/");
      current = new Set<number>();
      lines.set(path, current);
      line = 0;
      continue;
    }
    if (raw.startsWith("@@")) {
      const hunk = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(raw);
      if (hunk) line = Number(hunk[1]);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("+") || raw.startsWith(" ")) {
      current.add(line);
      line += 1;
    }
  }

  return lines;
}

/**
 * Turns findings into inline review comments. Findings without a `file:line`
 * location, or whose line is not part of the diff, are dropped instead of
 * failing the whole review.
 */
export function buildInlineComments(findings: AnalysisFinding[], diff: string): InlineComment[] {
  const available = commentedDiffLines(diff);
  const comments: InlineComment[] = [];

  for (const finding of findings) {
    if (comments.length >= MAX_INLINE_COMMENTS) break;
    const location = finding.location?.trim();
    if (!location) continue;
    const match = LOCATION_RE.exec(location);
    if (!match) continue;
    const path = match[1]!.replace(/\\/g, "/").replace(/^\.\//, "");
    const line = Number(match[2]);
    const fileLines = available.get(path);
    if (!fileLines || !fileLines.has(line)) continue;
    comments.push({
      path,
      line,
      body: `**[${severityLabel(finding.severity)}]** ${finding.text}`,
    });
  }

  return comments;
}

async function postReview(
  target: GithubCommentTarget,
  summary: string,
  comments: InlineComment[],
): Promise<void> {
  const response = await fetch(`${target.apiUrl}/repos/${target.repo}/pulls/${target.issue}/reviews`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${target.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      body: summary,
      event: "COMMENT",
      comments: comments.map((comment) => ({
        path: comment.path,
        line: comment.line,
        side: "RIGHT",
        body: comment.body,
      })),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new PilotError("Не удалось отправить review в PR (GitHub API)", {
      hint: `HTTP ${response.status} ${detail.slice(0, 300)}

Проверьте permissions: pull-requests: write у GITHUB_TOKEN.`,
      exitCode: 1,
    });
  }
}

export interface PostedReview {
  inline: boolean;
  count: number;
}

/**
 * Posts a pull-request review: inline comments on the diff when the job runs in
 * Actions with a token, otherwise (or if GitHub rejects the inline review) one
 * summary comment through the same channel as `--pr` always used.
 */
export async function postPrReviewSummary(
  summary: string,
  comments: InlineComment[],
  cwd: string,
): Promise<PostedReview> {
  const target = githubCommentTarget();
  if (target && comments.length > 0) {
    try {
      await postReview(target, summary, comments);
      return { inline: true, count: comments.length };
    } catch (error) {
      log.warn(
        `GitHub отклонил inline-комментарии (${
          error instanceof Error ? error.message : String(error)
        }) — отправляю сводку.`,
      );
    }
  }

  await postPrComment(summary, cwd);
  return { inline: false, count: 0 };
}

/**
 * Sets the `oc-pilot` commit status so a branch protection rule can require it.
 * Only works inside a PR Actions job (needs a token and a sha); returns false
 * when it cannot report instead of failing the review.
 */
export async function postPrStatus(
  state: "success" | "failure" | "error",
  description: string,
  sha: string,
): Promise<boolean> {
  const target = githubCommentTarget();
  if (!target || !sha) return false;

  try {
    const response = await fetch(`${target.apiUrl}/repos/${target.repo}/statuses/${sha}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${target.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        state,
        context: "oc-pilot",
        description: description.slice(0, 140),
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      log.warn(`Статус-чек не отправлен: HTTP ${response.status} ${detail.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (error) {
    log.warn(`Статус-чек не отправлен: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
