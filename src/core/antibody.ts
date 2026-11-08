import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { collectAddedLines } from "./alien-dna.js";
import { scanSource, type SastSeverity } from "./sast.js";
import { readRepository } from "./slop/collect.js";
import { isCodeFile, isGeneratedPath } from "./slop/source.js";

export type AntibodySeverity = SastSeverity;

export interface AntibodySignature {
  id: string;
  rule: string;
  severity: AntibodySeverity;
  message: string;
  snippet: string;
  normalized: string;
  file?: string;
  createdAt: string;
}

export interface AntibodyStore {
  version: 1;
  signatures: AntibodySignature[];
}

export interface AntibodyLearnResult {
  scanned: number;
  findings: number;
  added: number;
  total: number;
  store: string;
}

export interface AntibodyMatch {
  signatureId: string;
  rule: string;
  severity: AntibodySeverity;
  path: string;
  line: number;
  evidence: string;
}

export interface AntibodyScanReport {
  signatures: number;
  addedLines: number;
  matches: AntibodyMatch[];
  summary: string;
  content: string;
}

export interface AntibodyListReport {
  signatures: AntibodySignature[];
  content: string;
}

export interface AntibodyForgetResult {
  removed: boolean;
  remaining: number;
}

export interface AntibodyClearResult {
  removed: number;
}

export const ANTIBODY_STORE = ".oc-pilot/antibodies.json";
const STORE_VERSION = 1;

const KEYWORDS = new Set([
  "const",
  "let",
  "var",
  "function",
  "return",
  "await",
  "async",
  "true",
  "false",
  "null",
  "undefined",
  "this",
  "new",
  "if",
  "else",
  "for",
  "while",
  "import",
  "from",
  "require",
  "export",
  "default",
]);

export function antibodyStorePath(cwd: string): string {
  return join(cwd, ".oc-pilot", "antibodies.json");
}

/** Normalizes a source line so formatting and quotes do not hide a repeat. */
export function normalizeSnippet(text: string): string {
  return text
    .trim()
    .replace(/\/\/.*$/, "")
    .replace(/\s+/g, " ")
    .replace(/["'`][^"'`]*["'`]/g, '"str"')
    .replace(/;\s*$/, "")
    .slice(0, 200);
}

function tokensOf(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const token of text.split(/[^A-Za-z0-9_$]+/)) {
    if (token.length >= 3 && !KEYWORDS.has(token)) tokens.add(token);
  }
  return tokens;
}

function similarity(left: string, right: string): number {
  const a = tokensOf(left);
  const b = tokensOf(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.max(a.size, b.size);
}

function signatureId(rule: string, normalized: string): string {
  return `ab_${createHash("sha256").update(`${rule}:${normalized}`).digest("hex").slice(0, 16)}`;
}

function emptyStore(): AntibodyStore {
  return { version: STORE_VERSION, signatures: [] };
}

export function readAntibodyStore(cwd: string): AntibodyStore {
  const path = antibodyStorePath(cwd);
  if (!existsSync(path)) return emptyStore();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AntibodyStore>;
    if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.signatures)) return emptyStore();
    const signatures = parsed.signatures.filter((item): item is AntibodySignature => {
      if (!item || typeof item !== "object") return false;
      const record = item as Partial<AntibodySignature>;
      return (
        typeof record.id === "string" &&
        typeof record.rule === "string" &&
        typeof record.severity === "string" &&
        typeof record.message === "string" &&
        typeof record.snippet === "string" &&
        typeof record.normalized === "string" &&
        typeof record.createdAt === "string"
      );
    });
    return { version: STORE_VERSION, signatures };
  } catch {
    return emptyStore();
  }
}

function writeAntibodyStore(cwd: string, store: AntibodyStore): void {
  const path = antibodyStorePath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

/** Learns every SAST finding in the repository as a reusable signature. */
export function learnAntibodies(cwd: string): AntibodyLearnResult {
  const repo = readRepository(cwd);
  const store = readAntibodyStore(cwd);
  const byId = new Map(store.signatures.map((signature) => [signature.id, signature]));
  const createdAt = new Date().toISOString();
  let findings = 0;
  let added = 0;

  for (const file of repo.files) {
    if (!isCodeFile(file.path) || isGeneratedPath(file.path)) continue;
    const result = scanSource(file.path, file.text);
    for (const finding of result.findings) {
      findings += 1;
      const normalized = normalizeSnippet(finding.snippet);
      if (!normalized) continue;
      const id = signatureId(finding.rule, normalized);
      if (byId.has(id)) continue;
      byId.set(id, {
        id,
        rule: finding.rule,
        severity: finding.severity,
        message: finding.message,
        snippet: finding.snippet,
        normalized,
        file: finding.file,
        createdAt,
      });
      added += 1;
    }
  }

  const next: AntibodyStore = { version: STORE_VERSION, signatures: [...byId.values()] };
  writeAntibodyStore(cwd, next);
  return { scanned: repo.files.length, findings, added, total: next.signatures.length, store: ANTIBODY_STORE };
}

export function listAntibodies(cwd: string): AntibodyListReport {
  const store = readAntibodyStore(cwd);
  const signatures = [...store.signatures].sort((left, right) => left.rule.localeCompare(right.rule) || left.id.localeCompare(right.id));
  const lines = [`Antibody: подписей ${String(signatures.length)}.`];
  if (signatures.length === 0) {
    lines.push("Подписей нет. Сначала выполните oc-pilot antibody learn.");
  } else {
    for (const signature of signatures) {
      lines.push(
        `${signature.id} ${signature.severity.padEnd(6)} ${signature.rule.padEnd(20)} ${signature.snippet}`,
      );
    }
  }
  return { signatures, content: `${lines.join("\n")}\n` };
}

export function forgetAntibody(cwd: string, id: string): AntibodyForgetResult {
  const store = readAntibodyStore(cwd);
  const next = store.signatures.filter((signature) => signature.id !== id);
  if (next.length === store.signatures.length) return { removed: false, remaining: next.length };
  writeAntibodyStore(cwd, { version: STORE_VERSION, signatures: next });
  return { removed: true, remaining: next.length };
}

export function clearAntibodies(cwd: string): AntibodyClearResult {
  const store = readAntibodyStore(cwd);
  const path = antibodyStorePath(cwd);
  if (existsSync(path)) rmSync(path, { force: true });
  return { removed: store.signatures.length };
}

function isComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

function matchingSignature(
  path: string,
  line: string,
  signatures: AntibodySignature[],
): AntibodySignature | undefined {
  const normalized = normalizeSnippet(line);
  if (!normalized) return undefined;
  const exact = signatures.find((signature) => signature.normalized === normalized);
  if (exact) return exact;

  const detected = scanSource(path, line).findings;
  for (const finding of detected) {
    const known = signatures.find((signature) => signature.rule === finding.rule);
    if (known) return known;
  }

  let best: AntibodySignature | undefined;
  let bestScore = 0;
  for (const signature of signatures) {
    const score = similarity(normalized, signature.normalized);
    if (score > bestScore) {
      bestScore = score;
      best = signature;
    }
  }
  return bestScore >= 0.6 ? best : undefined;
}

/** Flags added diff lines that repeat a learned vulnerability pattern. */
export function scanAntibodies(cwd: string, diff: string): AntibodyScanReport {
  const store = readAntibodyStore(cwd);
  const added = collectAddedLines(diff).filter((line) => isCodeFile(line.path) && !isGeneratedPath(line.path));
  const matches: AntibodyMatch[] = [];
  const seen = new Set<string>();

  for (const line of added) {
    if (!line.text.trim() || isComment(line.text)) continue;
    const signature = matchingSignature(line.path, line.text, store.signatures);
    if (!signature) continue;
    const key = `${signature.id}:${line.path}:${String(line.line)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({
      signatureId: signature.id,
      rule: signature.rule,
      severity: signature.severity,
      path: line.path,
      line: line.line,
      evidence: line.text.trim().slice(0, 200),
    });
  }

  const summary =
    matches.length > 0
      ? `[ANTIBODY MATCH]: в diff вернулся известный паттерн уязвимости (${String(matches.length)}).`
      : "[ANTIBODY CLEAN]: известных паттернов уязвимости в diff нет.";
  const lines = [
    `Antibody: подписей ${String(store.signatures.length)}, добавленных строк ${String(added.length)}, совпадений ${String(matches.length)}.`,
  ];
  for (const match of matches) {
    lines.push(
      `  ${match.severity.toUpperCase().padEnd(6)} ${match.rule.padEnd(20)} ${match.path}:${String(match.line)} — ${match.evidence}`,
    );
  }
  lines.push("", summary);
  return {
    signatures: store.signatures.length,
    addedLines: added.length,
    matches,
    summary,
    content: `${lines.join("\n")}\n`,
  };
}
