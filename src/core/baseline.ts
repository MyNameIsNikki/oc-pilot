import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AnalysisFinding, FindingSeverity } from "../types.js";
import { parseFindingBullet } from "./findings.js";

const BASELINE_VERSION = 1;

export interface BaselineEntry {
  fingerprint: string;
  severity: FindingSeverity;
  file: string;
  line?: number;
  text: string;
}

export interface BaselineFile {
  version: number;
  createdAt: string;
  entries: BaselineEntry[];
}

export interface LoadedBaseline {
  path: string;
  fingerprints: Set<string>;
  count: number;
}

export function baselinePath(cwd: string): string {
  return join(cwd, ".oc-pilot", "baseline.json");
}

/**
 * Fingerprints are stable across line shifts: severity + file + normalized
 * text. The line number is stored for humans but never part of the hash.
 */
export function findingFingerprint(finding: AnalysisFinding): string {
  const location = /^(.*?)(?::\d+)?(?::\d+)?$/.exec(finding.location ?? "");
  const file = location?.[1]?.trim() ?? "";
  const normalizedText = finding.text.replace(/\s+/g, " ").trim();
  return createHash("sha256")
    .update(`${finding.severity}|${file}|${normalizedText}`)
    .digest("hex")
    .slice(0, 32);
}

export function loadBaseline(cwd: string): LoadedBaseline {
  const path = baselinePath(cwd);
  const empty: LoadedBaseline = { path, fingerprints: new Set(), count: 0 };
  if (!existsSync(path)) return empty;

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as BaselineFile;
    if (parsed.version !== BASELINE_VERSION || !Array.isArray(parsed.entries)) return empty;
    const fingerprints = new Set<string>();
    for (const entry of parsed.entries) {
      if (entry && typeof entry.fingerprint === "string" && entry.fingerprint) fingerprints.add(entry.fingerprint);
    }
    return { path, fingerprints, count: fingerprints.size };
  } catch {
    return empty;
  }
}

export function writeBaseline(cwd: string, findings: AnalysisFinding[]): { path: string; count: number } {
  const seen = new Set<string>();
  const entries: BaselineEntry[] = [];
  for (const finding of findings) {
    const fingerprint = findingFingerprint(finding);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    const match = /^(.*?)(?::\d+)?$/.exec(finding.location ?? "");
    const lineMatch = /:(\d+)(?::\d+)?$/.exec(finding.location ?? "");
    entries.push({
      fingerprint,
      severity: finding.severity,
      file: match?.[1]?.trim() ?? "",
      line: lineMatch ? Number(lineMatch[1]) : undefined,
      text: finding.text,
    });
  }
  entries.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));

  const path = baselinePath(cwd);
  const payload: BaselineFile = {
    version: BASELINE_VERSION,
    createdAt: new Date().toISOString(),
    entries,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return { path, count: entries.length };
}

export function filterFindings(
  findings: AnalysisFinding[],
  known: Set<string>,
): { kept: AnalysisFinding[]; knownCount: number } {
  const kept: AnalysisFinding[] = [];
  let knownCount = 0;
  for (const finding of findings) {
    if (known.has(findingFingerprint(finding))) {
      knownCount += 1;
      continue;
    }
    kept.push(finding);
  }
  return { kept, knownCount };
}

/**
 * Removes known findings from the `#### Замечания / Findings` section of an
 * analysis while preserving every other line (solutions, summaries) verbatim.
 */
export function filterAnalysisText(text: string, known: Set<string>): string {
  if (known.size === 0) return text;
  const normalized = text.replace(/\r\n?/g, "\n");
  const heading = /^####\s+(?:Замечания\s*\/\s*Действия|Findings\s*\/\s*Actions)\s*$/im.exec(normalized);
  if (!heading) return text;

  const start = heading.index + heading[0].length;
  const rest = normalized.slice(start);
  const nextHeading = /^####\s+/m.exec(rest);
  const sectionEnd = nextHeading ? nextHeading.index : rest.length;
  const section = rest.slice(0, sectionEnd);

  const keptLines: string[] = [];
  for (const line of section.split("\n")) {
    const finding = parseFindingBullet(line);
    if (finding && known.has(findingFingerprint(finding))) continue;
    keptLines.push(line);
  }

  return `${normalized.slice(0, start)}${keptLines.join("\n")}${rest.slice(sectionEnd)}`;
}
