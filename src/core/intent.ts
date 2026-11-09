export type CriterionStatus = "met" | "partial" | "unmet" | "unverifiable";

export interface IntentCriterionResult {
  text: string;
  status: CriterionStatus;
  evidence: string;
}

export type IntentStatus = "met" | "partial" | "unmet" | "inconclusive" | "error";

export interface IntentReport {
  source: string;
  results: IntentCriterionResult[];
  counts: Record<CriterionStatus, number>;
  status: IntentStatus;
  summary: string;
  content: string;
}

export type SphinxStatus = "clear" | "ambiguous" | "error";

export interface SphinxReport {
  status: SphinxStatus;
  questions: string[];
  assumptions: string[];
  criteria: string[];
  summary: string;
  content: string;
}

const MAX_CRITERIA = 30;
const MAX_ITEMS = 10;

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** Parses a Markdown checklist, numbered list or plain lines into criteria. */
export function parseCriteria(text: string): string[] {
  const criteria: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const cleaned = line
      .replace(/^[-*]\s*\[[ xX]\]\s*/, "")
      .replace(/^[-*]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .trim();
    if (cleaned.length >= 3) criteria.push(cleaned);
  }
  return unique(criteria).slice(0, MAX_CRITERIA);
}

function jsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function stringList(value: unknown, limit = MAX_ITEMS): string[] {
  if (!Array.isArray(value)) return [];
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const text = item.trim();
    if (!text) continue;
    items.push(text.slice(0, 500));
    if (items.length >= limit) break;
  }
  return items;
}

/** Parses the model's per-criterion verdicts and aligns them to the original list. */
export function parseIntentResults(text: string, criteria: string[]): IntentCriterionResult[] | undefined {
  const parsed = jsonObject(text);
  if (!parsed || !Array.isArray(parsed.criteria)) return undefined;
  const raw = parsed.criteria.filter(
    (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object",
  );
  if (raw.length === 0) return undefined;

  return criteria.map((criterion, index) => {
    const byText = raw.find(
      (item) => typeof item.text === "string" && item.text.trim().toLowerCase() === criterion.toLowerCase(),
    );
    const item = byText ?? raw[index];
    const status =
      typeof item?.status === "string" &&
      ["met", "partial", "unmet", "unverifiable"].includes(item.status)
        ? (item.status as CriterionStatus)
        : "unverifiable";
    const evidence = typeof item?.evidence === "string" && item.evidence.trim()
      ? item.evidence.trim().slice(0, 800)
      : "модель не вернула доказательство";
    return { text: criterion, status, evidence };
  });
}

export function buildIntentPrompt(criteria: string[], diff: string, context?: string): string {
  const cappedDiff = diff.length > 60_000 ? diff.slice(0, 60_000) : diff;
  return [
    "You are an acceptance-criteria auditor. Decide whether each criterion is satisfied by the proposed diff.",
    "Statuses: met (the diff clearly implements it), partial (some of it is present), unmet (the diff contradicts it or omits required behavior), unverifiable (the diff cannot show it).",
    "Evidence must point to a concrete file, line or behavior in the diff. Do not invent criteria and do not judge the author.",
    context ? `Extra context from the author:\n${context}` : "",
    "Return strict JSON only, with no markdown and no prose outside the object:",
    '{"criteria":[{"text":"exact criterion","status":"met","evidence":"src/auth.ts adds the reset endpoint"}]}',
    "",
    "CRITERIA:",
    ...criteria.map((criterion, index) => `${String(index + 1)}. ${criterion}`),
    "",
    "DIFF:",
    cappedDiff,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

export function evaluateIntent(
  criteria: string[],
  results: IntentCriterionResult[],
  source: string,
): IntentReport {
  const counts: Record<CriterionStatus, number> = {
    met: 0,
    partial: 0,
    unmet: 0,
    unverifiable: 0,
  };
  for (const result of results) counts[result.status] += 1;

  const status: IntentStatus =
    counts.unmet > 0
      ? "unmet"
      : counts.partial > 0
        ? "partial"
        : counts.unverifiable > 0
          ? "inconclusive"
          : "met";
  const summary =
    status === "unmet"
      ? `[INTENT UNMET]: ${String(counts.unmet)} из ${String(criteria.length)} критериев не выполнены.`
      : status === "partial"
        ? `[INTENT PARTIAL]: ${String(counts.partial)} из ${String(criteria.length)} критериев выполнены частично.`
        : status === "inconclusive"
          ? `[INTENT INCONCLUSIVE]: ${String(counts.unverifiable)} из ${String(criteria.length)} критериев нельзя проверить по diff.`
          : `[INTENT MET]: все ${String(criteria.length)} критериев подтверждены diff.`;

  const lines = [
    `Intent: ${status}`,
    `Source: ${source}`,
    `Criteria: met ${String(counts.met)}, partial ${String(counts.partial)}, unmet ${String(counts.unmet)}, unverifiable ${String(counts.unverifiable)}`,
    "",
  ];
  for (const result of results) {
    lines.push(`  [${result.status.toUpperCase()}] ${result.text}`);
    lines.push(`    ${result.evidence}`);
  }
  lines.push("", summary);
  return {
    source,
    results,
    counts,
    status,
    summary,
    content: `${lines.join("\n")}\n`,
  };
}

export function buildSphinxPrompt(request: string, context?: string): string {
  const capped = request.length > 20_000 ? request.slice(0, 20_000) : request;
  return [
    "You are a requirements interrogator. Before code is written, find what the request leaves undecided.",
    "Return strict JSON only, with no markdown and no prose outside the object:",
    '{"questions":["who can trigger this?"],"assumptions":["the default timeout stays 30s"],"criteria":["an expired token returns 401"]}',
    "questions: decisions that change the implementation and are missing from the request.",
    "assumptions: things you had to assume to make the request testable.",
    "criteria: testable acceptance criteria implied by the request.",
    "Be concrete and short. Do not ask for praise or preferences. If the request is already clear, return empty arrays.",
    context ? `Extra context:\n${context}` : "",
    "",
    "REQUEST:",
    capped,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

export function parseSphinxReport(text: string): SphinxReport | undefined {
  const parsed = jsonObject(text);
  if (!parsed) return undefined;
  const questions = stringList(parsed.questions);
  const assumptions = stringList(parsed.assumptions);
  const criteria = stringList(parsed.criteria);
  if (
    !Array.isArray(parsed.questions) &&
    !Array.isArray(parsed.assumptions) &&
    !Array.isArray(parsed.criteria)
  ) {
    return undefined;
  }
  const status: SphinxStatus = questions.length > 0 || assumptions.length > 0 ? "ambiguous" : "clear";
  const summary =
    status === "ambiguous"
      ? `[REQUIREMENTS AMBIGUOUS]: ${String(questions.length)} вопрос(ов), ${String(assumptions.length)} допущени(й).`
      : "[REQUIREMENTS CLEAR]: вопросов и допущений нет, критерии сформулированы.";
  const lines = [
    `Sphinx: ${status}`,
    `Questions: ${String(questions.length)}`,
    ...questions.map((question) => `  ? ${question}`),
    `Assumptions: ${String(assumptions.length)}`,
    ...assumptions.map((assumption) => `  ~ ${assumption}`),
    `Criteria: ${String(criteria.length)}`,
    ...criteria.map((criterion) => `  + ${criterion}`),
    "",
    summary,
  ];
  return { status, questions, assumptions, criteria, summary, content: `${lines.join("\n")}\n` };
}

export function renderIntent(report: IntentReport): string {
  return report.content;
}

export function renderSphinx(report: SphinxReport): string {
  return report.content;
}
