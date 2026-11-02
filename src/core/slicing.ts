import type { PromptLang } from "../types.js";
import { splitDiffBlocks } from "./diff.js";
import { parseFindings, severityLabel } from "./findings.js";

/**
 * Smart slicing for engine=openai: instead of truncating a huge diff (and
 * losing files), split it into per-file slices that each fit the prompt
 * budget, run one API call per slice and merge the responses back into a
 * single schema-compliant analysis.
 */

export interface SlicePlan {
  /** Diff text per slice; each slice fits the budget unless a single file is oversized. */
  slices: string[];
  /** File paths per slice, parallel to `slices`. */
  filesPerSlice: string[][];
  /** Files whose own diff block exceeds the budget (truncated downstream). */
  oversized: string[];
}

const MIN_BLOCK_BUDGET = 1_000;

export function planDiffSlices(diff: string, budget: number): SlicePlan {
  const blocks = splitDiffBlocks(diff);
  if (blocks.length === 0) return { slices: [], filesPerSlice: [], oversized: [] };

  const safeBudget = Math.max(MIN_BLOCK_BUDGET, budget);
  const slices: string[] = [];
  const filesPerSlice: string[][] = [];
  const oversized: string[] = [];
  let current: string[] = [];
  let currentFiles: string[] = [];
  let used = 0;

  const flush = (): void => {
    if (current.length > 0) {
      slices.push(current.join(""));
      filesPerSlice.push(currentFiles);
    }
    current = [];
    currentFiles = [];
    used = 0;
  };

  for (const block of blocks) {
    if (block.text.length > safeBudget) {
      oversized.push(block.path);
      flush();
      slices.push(block.text);
      filesPerSlice.push([block.path]);
      continue;
    }
    if (current.length > 0 && used + block.text.length > safeBudget) flush();
    current.push(block.text);
    currentFiles.push(block.path);
    used += block.text.length;
  }
  flush();

  return { slices, filesPerSlice, oversized };
}

const LGTM_RU = "LGTM: критических проблем не обнаружено.";
const LGTM_EN = "LGTM: no critical issues found.";
const LGTM_RE = /^LGTM:\s*(?:критических проблем не обнаружено|no critical issues found)\.?\s*$/im;

/** Single-line LGTM analysis used by slicing merges and the two-phase router. */
export function lgtmText(lang: PromptLang): string {
  return lang === "ru" ? LGTM_RU : LGTM_EN;
}

function analysisSummary(text: string): string | undefined {
  const match = /^###\s+(?:Анализ|Analysis)\s*:\s*(.+)$/m.exec(text);
  return match?.[1]?.trim();
}

/**
 * Extracts the `#### Решение` / `#### Solution` section (up to the next
 * heading or end of text) from one slice response.
 */
export function solutionSection(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((line) => /^####\s+(?:Решение|Solution)\s*$/.test(line.trim()));
  if (start === -1) return "";
  const collected: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^#{2,4}\s/.test(line)) break;
    collected.push(line);
  }
  return collected.join("\n").trim();
}

export interface MergedAnalysis {
  text: string;
  allLgtm: boolean;
  sliceCount: number;
}

/**
 * Merges per-slice responses into one response that follows the OUTPUT
 * SCHEMA: a single `### Анализ` line, one `#### Замечания / Действия`
 * section with re-rendered findings from every slice, and one `#### Решение`
 * section with the solutions concatenated verbatim.
 */
export function mergeSliceAnalyses(responses: string[], lang: PromptLang = "en"): MergedAnalysis {
  const valid = responses.filter((response) => response.trim());
  if (valid.length === 0) {
    return { text: "", allLgtm: false, sliceCount: 0 };
  }

  if (valid.every((response) => LGTM_RE.test(response))) {
    return { text: lang === "ru" ? LGTM_RU : LGTM_EN, allLgtm: true, sliceCount: valid.length };
  }

  const ru = lang === "ru";
  const sliceWord = ru ? "частям" : "slices";
  const summaries = valid.map(analysisSummary).filter((summary): summary is string => Boolean(summary));
  const summaryLine = [ru ? `Ревью выполнено по ${valid.length} ${sliceWord}.` : `Review completed across ${valid.length} ${sliceWord}.`, ...summaries].join(" ");

  const findings = valid.flatMap((response) => parseFindings(response));
  const bullets =
    findings.length > 0
      ? findings.map((finding) => {
          const location = finding.location ? ` \`${finding.location}\`` : "";
          return `- **[${severityLabel(finding.severity)}${location}]: ${finding.text}`;
        })
      : [ru ? "- Замечаний нет." : "- No findings."];

  const solutions = valid
    .map((response) => solutionSection(response))
    .filter((solution) => solution.length > 0);

  const text = [
    ru ? `### Анализ: ${summaryLine}` : `### Analysis: ${summaryLine}`,
    "",
    ru ? "#### Замечания / Действия" : "#### Findings / Actions",
    ...bullets,
    "",
    ru ? "#### Решение" : "#### Solution",
    solutions.length > 0 ? solutions.join("\n\n") : ru ? "(нет)" : "(none)",
    "",
  ].join("\n");

  return { text, allLgtm: false, sliceCount: valid.length };
}
