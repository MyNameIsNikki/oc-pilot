/**
 * Two-phase routing: a cheap triage model decides whether the main review
 * call is needed at all. The decision line is machine-readable; anything
 * unparsable falls back to a full review (safe default).
 */
export type TriageDecision = "review" | "lgtm" | "unknown";

const TRIAGE_LINE = /TRIAGE:\s*(REVIEW|LGTM)\b/i;

export function parseTriageDecision(text: string): TriageDecision {
  const match = TRIAGE_LINE.exec(text);
  if (!match) return "unknown";
  return match[1]!.toUpperCase() === "LGTM" ? "lgtm" : "review";
}
