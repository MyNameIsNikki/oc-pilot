export type TribunalLens = "security" | "correctness" | "maintainability";
export type TribunalSeverity = "high" | "medium" | "low";

export interface TribunalFinding {
  lens: TribunalLens;
  severity: TribunalSeverity;
  issue: string;
  file?: string;
  line?: number;
}

export interface TribunalVerdict {
  issue: string;
  severity: TribunalSeverity;
  lenses: TribunalLens[];
  consensus: boolean;
  file?: string;
  line?: number;
}

export interface TribunalReport {
  lenses: TribunalLens[];
  findings: TribunalFinding[];
  verdicts: TribunalVerdict[];
  status: "consensus" | "split" | "clean" | "error";
  summary: string;
  content: string;
}

const SEVERITIES: TribunalSeverity[] = ["high", "medium", "low"];
const LENSES: TribunalLens[] = ["security", "correctness", "maintainability"];
const MAX_FINDINGS = 5;

export function isTribunalLens(value: string): value is TribunalLens {
  return (LENSES as string[]).includes(value);
}

export function parseTribunalLens(value: string): TribunalLens {
  if (isTribunalLens(value)) return value;
  throw new Error(`unknown lens: ${value}`);
}

export function buildTribunalPrompt(lens: TribunalLens, diff: string): string {
  const focus =
    lens === "security"
      ? "security only: injection, authz, secrets, unsafe deserialization, SSRF, path traversal"
      : lens === "correctness"
        ? "correctness only: logic, edge cases, error handling, races, off-by-one, resource leaks"
        : "maintainability only: duplication, dead code, naming, complexity, hidden coupling";
  const capped = diff.length > 60_000 ? diff.slice(0, 60_000) : diff;
  return [
    `You are the ${lens} member of a code tribunal. Review ${focus}.`,
    "Report only concrete defects introduced or exposed by the diff. Do not praise, do not summarize and do not repeat the diff.",
    "Return strict JSON only, with no markdown and no prose outside the object:",
    '{"findings":[{"severity":"high","file":"src/x.ts","line":12,"issue":"what is wrong and why"}]}',
    `At most ${String(MAX_FINDINGS)} findings. Use severity high, medium or low. If there are no findings, return {"findings":[]}.`,
    "",
    "DIFF:",
    capped,
  ].join("\n");
}

export function parseTribunalFindings(text: string, lens: TribunalLens): TribunalFinding[] | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const list = (parsed as Record<string, unknown>).findings;
  if (!Array.isArray(list)) return undefined;

  const findings: TribunalFinding[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const issue = typeof record.issue === "string" ? record.issue.trim() : "";
    if (!issue) continue;
    const severity =
      typeof record.severity === "string" && (SEVERITIES as string[]).includes(record.severity)
        ? (record.severity as TribunalSeverity)
        : "medium";
    findings.push({
      lens,
      severity,
      issue: issue.slice(0, 500),
      file: typeof record.file === "string" && record.file.trim() ? record.file.trim() : undefined,
      line:
        typeof record.line === "number" && Number.isInteger(record.line) && record.line > 0
          ? record.line
          : undefined,
    });
    if (findings.length >= MAX_FINDINGS) break;
  }
  return findings;
}

function severityRank(severity: TribunalSeverity): number {
  return severity === "high" ? 3 : severity === "medium" ? 2 : 1;
}

function keyOf(finding: TribunalFinding): string {
  return `${finding.file ?? ""}:${String(finding.line ?? 0)}:${finding.issue.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 160)}`;
}

export function aggregateTribunal(
  lenses: TribunalLens[],
  findings: TribunalFinding[],
  minConsensus = 2,
): TribunalReport {
  const groups = new Map<string, TribunalVerdict>();
  for (const finding of findings) {
    const key = keyOf(finding);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        issue: finding.issue,
        severity: finding.severity,
        lenses: [finding.lens],
        consensus: false,
        file: finding.file,
        line: finding.line,
      });
      continue;
    }
    if (!existing.lenses.includes(finding.lens)) existing.lenses.push(finding.lens);
    if (severityRank(finding.severity) > severityRank(existing.severity)) existing.severity = finding.severity;
  }

  const threshold = Math.max(1, Math.min(lenses.length, minConsensus));
  const verdicts = [...groups.values()].map((verdict) => ({
    ...verdict,
    lenses: [...verdict.lenses].sort(),
    consensus: verdict.lenses.length >= threshold,
  }));
  verdicts.sort(
    (left, right) =>
      Number(right.consensus) - Number(left.consensus) ||
      severityRank(right.severity) - severityRank(left.severity) ||
      left.issue.localeCompare(right.issue),
  );

  const consensus = verdicts.filter((verdict) => verdict.consensus);
  const status: TribunalReport["status"] =
    consensus.length > 0 ? "consensus" : verdicts.length > 0 ? "split" : "clean";
  const summary =
    status === "consensus"
      ? `[TRIBUNAL CONSENSUS]: ${String(consensus.length)} находок подтверждены минимум ${String(threshold)} членами.`
      : status === "split"
        ? `[TRIBUNAL SPLIT]: ${String(verdicts.length)} находок, но ни одна не набрала ${String(threshold)} голосов.`
        : "[TRIBUNAL CLEAN]: находок нет.";

  const lines = [
    `Tribunal: ${status}`,
    `Lenses: ${lenses.join(", ")}`,
    `Findings: ${String(findings.length)}, verdicts: ${String(verdicts.length)}, consensus: ${String(consensus.length)}`,
  ];
  for (const verdict of verdicts.slice(0, 30)) {
    const at = verdict.file ? ` (${verdict.file}${verdict.line ? `:${String(verdict.line)}` : ""})` : "";
    lines.push(
      `  [${verdict.consensus ? "CONSENSUS" : "SPLIT"}] ${verdict.severity.toUpperCase()} ${verdict.lenses.join("+")}${at}: ${verdict.issue}`,
    );
  }
  lines.push("", summary);
  return {
    lenses,
    findings,
    verdicts,
    status,
    summary,
    content: `${lines.join("\n")}\n`,
  };
}

export function renderTribunal(report: TribunalReport): string {
  return report.content;
}
