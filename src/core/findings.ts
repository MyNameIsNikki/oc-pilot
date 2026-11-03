import type { AnalysisFinding, FailOn, FindingSeverity } from "../types.js";

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  critical: 3,
  warning: 2,
  style: 1,
};

const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  critical: "🔴 Critical",
  warning: "🟡 Warning",
  style: "🔵 Style",
};

export function severityRank(severity: FindingSeverity): number {
  return SEVERITY_RANK[severity];
}

export function severityLabel(severity: FindingSeverity): string {
  return SEVERITY_LABEL[severity];
}

export function parseFailOn(raw: string): FailOn {
  const value = raw.trim().toLowerCase();
  if (value === "none" || value === "off" || value === "false") return "none";
  if (value === "critical" || value === "crit" || value === "error") return "critical";
  if (value === "warning" || value === "warn") return "warning";
  if (value === "style" || value === "note" || value === "any" || value === "all") return "style";
  throw new Error(`неизвестный уровень "${raw}" (допустимо: none, critical, warning, style)`);
}

function detectSeverity(text: string): FindingSeverity | undefined {
  if (/🔴|critical|критич/i.test(text)) return "critical";
  if (/🟡|warning|предупрежд/i.test(text)) return "warning";
  if (/🔵|style|note|стиль|замечан/i.test(text)) return "style";
  return undefined;
}

const LINE_RANGE = /^(.*?):(\d+)(?::(\d+))?(?:\s*[-–—,]\s*\d+(?::\d+)?)*$/;
const HASH_LINE = /^(.*?)#L(\d+)(?:-L?\d+)?$/i;
const WORD_LINE = /^(.*?)\s*\(?\s*(?:line|строк[аи])\s*(\d+)\s*\)?$/i;

/**
 * Brings the location formats models actually produce to `file:line[:column]`:
 * `a.ts:10-14` → `a.ts:10`, `a.ts:10,12` → `a.ts:10`, `a.ts#L10` → `a.ts:10`,
 * `a.ts (line 10)` → `a.ts:10`. Ranges collapse to their first line because the
 * PR/MR APIs anchor a comment to a single line. Unknown shapes are kept as-is.
 */
export function normalizeLocation(value: string): string | undefined {
  const raw = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!raw) return undefined;

  const range = LINE_RANGE.exec(raw);
  if (range) {
    const file = (range[1] ?? "").trim();
    if (!file) return undefined;
    return `${file}:${range[2]}${range[3] ? `:${range[3]}` : ""}`;
  }

  const hash = HASH_LINE.exec(raw);
  if (hash) {
    const file = (hash[1] ?? "").trim();
    if (file) return `${file}:${hash[2]}`;
  }

  const word = WORD_LINE.exec(raw);
  if (word) {
    const file = (word[1] ?? "").trim();
    if (file) return `${file}:${word[2]}`;
  }

  return raw;
}

function stripMarkdown(value: string): string {
  return value
    .replace(/`/g, "")
    .replace(/\*\*/g, "")
    .replace(/^\s*[-*]\s*/, "")
    .trim();
}

/**
 * Extracts findings from the `#### Замечания / Действия` (or `#### Findings /
 * Actions`) section of an analysis response. The output schema is intentionally
 * simple, but models vary in spacing and emphasis, so the parser is permissive.
 */
/** Parses a single findings bullet; returns undefined for non-finding lines. */
export function parseFindingBullet(line: string): AnalysisFinding | undefined {
  const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
  if (!bullet) return undefined;

  const body = bullet[1]!.trim();
  const severity = detectSeverity(body);
  if (!severity) return undefined;

  const locationMatch = /`([^`]+)`/.exec(body);
  const location = locationMatch ? normalizeLocation(locationMatch[1]!) : undefined;

  let rawText = body;
  if (locationMatch) rawText = rawText.replace(locationMatch[0], "");
  let text = stripMarkdown(rawText);
  text = text
    .replace(/^🔴\s*/, "")
    .replace(/^🟡\s*/, "")
    .replace(/^🔵\s*/, "")
    .replace(
      /^(?:critical|warning|style|note|критич\w*|предупрежд\w*|стиль)(?:\s*\/\s*(?:critical|warning|style|note|критич\w*|предупрежд\w*|стиль))?\s*[:—-]?\s*/i,
      "",
    )
    .replace(/^\/\s*/, "")
    .replace(/^[:\s—-]+/, "")
    .trim();

  return { severity, location, text: text || "замечание без описания" };
}

export function parseFindings(markdown: string): AnalysisFinding[] {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  if (/LGTM:\s*(?:критических проблем не обнаружено|no critical issues found)/i.test(normalized)) return [];

  const heading = /^####\s+(?:Замечания|Findings)(?:\s*\/\s*(?:Действия|Actions))?\s*:?\s*$/im.exec(normalized);
  if (!heading) return [];

  const start = heading.index + heading[0].length;
  const rest = normalized.slice(start);
  const nextHeading = /^####\s+/m.exec(rest);
  const section = (nextHeading ? rest.slice(0, nextHeading.index) : rest).trim();
  if (!section) return [];

  const findings: AnalysisFinding[] = [];
  let fenced = false;
  for (const line of section.split("\n")) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const finding = parseFindingBullet(line);
    if (finding) findings.push(finding);
  }

  return findings;
}

export function countFindings(findings: AnalysisFinding[]): Record<FindingSeverity, number> {
  return {
    critical: findings.filter((finding) => finding.severity === "critical").length,
    warning: findings.filter((finding) => finding.severity === "warning").length,
    style: findings.filter((finding) => finding.severity === "style").length,
  };
}

export function failThreshold(failOn: FailOn): number {
  return failOn === "none" ? 0 : SEVERITY_RANK[failOn];
}

export function shouldFail(findings: AnalysisFinding[], failOn: FailOn): boolean {
  const threshold = failThreshold(failOn);
  if (threshold === 0) return false;
  return findings.some((finding) => SEVERITY_RANK[finding.severity] >= threshold);
}

export function describeFindings(findings: AnalysisFinding[]): string {
  const counts = countFindings(findings);
  return `🔴 ${counts.critical} · 🟡 ${counts.warning} · 🔵 ${counts.style}`;
}
