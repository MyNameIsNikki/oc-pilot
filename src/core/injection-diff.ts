/**
 * Prompt-injection heuristics for added diff lines. Kept separate from the
 * repository-wide content scan so the review pipeline can keep its compact
 * finding shape.
 */
export interface DiffInjectionFinding {
  file: string;
  line: number;
  pattern: string;
  preview: string;
}

const INJECTION_PATTERNS: Array<{ id: string; regex: RegExp }> = [
  { id: "instruction-override", regex: /ignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+instructions?/i },
  { id: "disregard", regex: /disregard\s+(?:the\s+)?(?:above|previous|all|everything)/i },
  { id: "role-hijack", regex: /you\s+are\s+now\s+(?:a|an)\s+/i },
  { id: "prompt-exfiltration", regex: /(?:reveal|print|repeat|show)\s+(?:your|the)\s+(?:system\s+)?(?:prompt|instructions)/i },
  { id: "base64-blob", regex: /(?:[A-Za-z0-9+/]{80,}={0,2})/ },
  { id: "invisible-unicode", regex: /[\u200B-\u200D\u2060\u202A-\u202E\uFEFF]/ },
];

const HUNK_HEADER = /^@@\s*-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*@@/;
const MAX_PREVIEW_CHARS = 80;

function previewOf(line: string): string {
  const cleaned = line.replace(/[\u200B-\u200D\u2060\u202A-\u202E\uFEFF]/g, "?").trim();
  return cleaned.length > MAX_PREVIEW_CHARS ? `${cleaned.slice(0, MAX_PREVIEW_CHARS)}…` : cleaned;
}

/** Scans ADDED lines of a unified diff for injection-looking content. */
export function scanDiffForInjection(diff: string): DiffInjectionFinding[] {
  const findings: DiffInjectionFinding[] = [];
  let file = "";
  let newLine = 0;

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      file = line.slice(4).replace(/^b\//, "").trim();
      continue;
    }
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const content = line.slice(1);
      for (const { id, regex } of INJECTION_PATTERNS) {
        if (regex.test(content)) {
          findings.push({ file: file || "(diff)", line: newLine, pattern: id, preview: previewOf(content) });
          break;
        }
      }
      newLine += 1;
      continue;
    }
    if (line.startsWith("-")) continue;
    if (line.trim() !== "") newLine += 1;
  }

  return findings;
}

/** Renders findings for the prompt context block (no raw content beyond previews). */
export function describeInjectionFindings(findings: DiffInjectionFinding[]): string {
  return findings
    .map((finding) => `- ${finding.file}:${finding.line} [${finding.pattern}] ${finding.preview}`)
    .join("\n");
}
