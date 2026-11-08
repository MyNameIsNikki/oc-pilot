import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { PilotError } from "./errors.js";
import { isGitRepo, runGit } from "./git.js";
import { isGeneratedPath, isTestFile } from "./slop/source.js";

export type InjectionSeverity = "high" | "medium" | "low";
export type InjectionKind =
  | "override"
  | "exfiltration"
  | "hidden-unicode"
  | "hidden-html"
  | "encoded"
  | "prompt-leak"
  | "tool-instruction";

export interface InjectionFinding {
  file: string;
  line: number;
  kind: InjectionKind;
  severity: InjectionSeverity;
  rule: string;
  evidence: string;
}

export interface InjectionReport {
  files: number;
  findings: InjectionFinding[];
  counts: Record<InjectionSeverity, number>;
  summary: string;
  content: string;
}

export interface InjectionOptions {
  include?: string[];
  exclude?: string[];
  maxFiles?: number;
}

export interface InjectionFixResult {
  files: number;
  removed: number;
}

const MAX_FILE_BYTES = 256_000;
const MAX_FILES = 3_000;
const TEXT_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".txt",
  ".rst",
  ".html",
  ".htm",
  ".css",
  ".json",
  ".jsonc",
  ".yml",
  ".yaml",
  ".toml",
  ".xml",
  ".svg",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".rb",
  ".php",
  ".cs",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".swift",
  ".scala",
  ".sh",
  ".ps1",
  ".sql",
  ".env",
  ".example",
  ".ini",
  ".cfg",
  ".conf",
  ".dockerfile",
]);
const TEXT_NAMES = new Set(["Dockerfile", "Makefile", ".gitignore", ".dockerignore", ".npmignore"]);
const SKIP_DIRS = new Set([
  ".git",
  ".oc-pilot",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  ".next",
  "target",
  ".cache",
]);
const SEVERITY_RANK: Record<InjectionSeverity, number> = { high: 3, medium: 2, low: 1 };

interface Rule {
  id: string;
  kind: InjectionKind;
  severity: InjectionSeverity;
  pattern: RegExp;
}

const RULES: Rule[] = [
  {
    id: "ignore-previous",
    kind: "override",
    severity: "high",
    pattern:
      /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|system|developer)\b[^.\n]{0,24}\b(?:instructions?|prompts?|rules?|messages?)\b/i,
  },
  {
    id: "new-role",
    kind: "override",
    severity: "high",
    pattern: /\b(?:you are now|act as|from now on you|your new role is|pretend to be)\b/i,
  },
  {
    id: "prompt-leak",
    kind: "prompt-leak",
    severity: "high",
    pattern:
      /\b(?:reveal|show|print|repeat|output|dump)\b[^.\n]{0,36}\b(?:system prompt|developer message|hidden instructions|initial prompt|internal rules)\b/i,
  },
  {
    id: "exfiltrate",
    kind: "exfiltration",
    severity: "high",
    pattern:
      /\b(?:exfiltrate|send|upload|post)\s+(?:the\s+)?(?:contents?\s+of\s+)?(?:\.env|environment variables|api[_-]?keys?|secrets?|tokens?|credentials?|\.ssh|\.aws)\b(?!\s+into)|\b(?:curl|wget)\b[^.\n]{0,40}\b(?:\.env|secrets?|tokens?|credentials?)\b/i,
  },
  {
    id: "silent",
    kind: "override",
    severity: "high",
    pattern:
      /\b(?:do not|don't|never)\b[^.\n]{0,24}\b(?:tell|inform|notify|mention|reveal)\b[^.\n]{0,24}\b(?:user|human|operator)\b/i,
  },
  {
    id: "jailbreak",
    kind: "override",
    severity: "high",
    pattern:
      /\b(?:enable|activate|enter|use)\s+(?:DAN mode|developer mode|jailbreak mode|jailbreak)\b|\b(?:no restrictions|bypass (?:safety|guardrails|policy))\b/i,
  },
];

const HIDDEN_UNICODE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/u;
const HIDDEN_CSS =
  /(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|color\s*:\s*transparent|opacity\s*:\s*0|left\s*:\s*-\d{3,}px)/i;
const INSTRUCTION_WORDS =
  /\b(?:ignore|disregard|forget|run|execute|send|upload|exfiltrate|secret|token|\.env|system prompt|instructions?)\b/i;
const BASE64 = /[A-Za-z0-9+/]{80,}={0,2}/g;
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(([^)]+)\)/g;
const HTML_IMAGE = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
const SELF_PATHS = new Set(["src/core/injection.ts", "src/core/injection-diff.ts"]);

function extension(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  if (TEXT_NAMES.has(name)) return name;
  const at = name.lastIndexOf(".");
  return at >= 0 ? name.slice(at).toLowerCase() : "";
}

function isTextFile(path: string): boolean {
  if (TEXT_NAMES.has(path.split(/[\\/]/).pop() ?? "")) return true;
  return TEXT_EXTENSIONS.has(extension(path));
}

function walk(cwd: string, dir: string, out: string[], limit: number): void {
  if (out.length >= limit) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= limit) return;
    if (entry.name.startsWith(".") && entry.name !== ".github" && entry.name !== ".env.example" && entry.name !== ".gitignore") {
      if (SKIP_DIRS.has(entry.name)) continue;
    }
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(cwd, full, out, limit);
    } else if (entry.isFile()) {
      const rel = relative(cwd, full).replace(/\\/g, "/");
      if (isTextFile(rel)) out.push(rel);
    }
  }
}

function listFiles(cwd: string, limit: number): string[] {
  if (isGitRepo(cwd)) {
    const result = runGit(["ls-files", "-co", "--exclude-standard", "-z"], cwd);
    if (result.status === 0) {
      const files = result.stdout
        .split("\0")
        .map((value) => value.trim().replace(/\\/g, "/"))
        .filter(
          (value) =>
            value.length > 0 &&
            isTextFile(value) &&
            !isGeneratedPath(value) &&
            !isTestFile(value) &&
            !SELF_PATHS.has(value),
        );
      if (files.length > 0) return files.slice(0, limit);
    }
  }
  const out: string[] = [];
  walk(cwd, cwd, out, limit);
  return out.filter((file) => !isGeneratedPath(file) && !isTestFile(file) && !SELF_PATHS.has(file));
}

function pathMatches(path: string, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((pattern) => {
    const clean = pattern.replace(/\\/g, "/");
    if (clean.includes("*")) {
      const regex = new RegExp(`^${clean.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
      return regex.test(path);
    }
    return path === clean || path.startsWith(`${clean.replace(/\/$/, "")}/`);
  });
}

function safeEvidence(line: string): string {
  const escaped = line
    .replace(HIDDEN_UNICODE, (char) => `\\u{${char.codePointAt(0)?.toString(16).toUpperCase()}}`)
    .replace(/\s+/g, " ")
    .trim();
  return escaped.length > 200 ? `${escaped.slice(0, 197)}...` : escaped;
}

function suspiciousUrl(url: string): boolean {
  const lower = url.toLowerCase();
  if (/(?:^|[?&])(?:env|secret|token|key|data|prompt|context)=/i.test(lower)) return true;
  if (/(?:process\.env|os\.environ|import\.meta\.env)/i.test(url)) return true;
  if (/\$\{[^}]*(?:process\.env|env\.|secret|token|key)[^}]*\}/i.test(url)) return true;
  if (/\{\{[^}]*(?:env|secret|token|key)[^}]*\}\}/i.test(url)) return true;
  return url.length > 180 && /(?:[?&][A-Za-z0-9+/=_-]{40,})/.test(url);
}

function scanText(file: string, text: string): InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  const lines = text.split(/\r?\n/);
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at]!;
    const lineNo = at + 1;
    if (line.includes("oc-pilot:ignore-injection")) continue;

    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        findings.push({ file, line: lineNo, kind: rule.kind, severity: rule.severity, rule: rule.id, evidence: safeEvidence(line) });
      }
    }

    if (HIDDEN_UNICODE.test(line)) {
      findings.push({
        file,
        line: lineNo,
        kind: "hidden-unicode",
        severity: "high",
        rule: "hidden-unicode",
        evidence: safeEvidence(line),
      });
    }

    for (const match of line.matchAll(MARKDOWN_IMAGE)) {
      if (match[1] && suspiciousUrl(match[1])) {
        findings.push({ file, line: lineNo, kind: "exfiltration", severity: "high", rule: "markdown-image", evidence: safeEvidence(line) });
      }
    }
    for (const match of line.matchAll(HTML_IMAGE)) {
      if (match[1] && suspiciousUrl(match[1])) {
        findings.push({ file, line: lineNo, kind: "exfiltration", severity: "high", rule: "html-image", evidence: safeEvidence(line) });
      }
    }

    if (HIDDEN_CSS.test(line)) {
      const window = lines.slice(at, Math.min(lines.length, at + 4)).join(" ");
      if (INSTRUCTION_WORDS.test(window)) {
        findings.push({ file, line: lineNo, kind: "hidden-html", severity: "high", rule: "hidden-css", evidence: safeEvidence(line) });
      }
    }

    for (const match of line.matchAll(BASE64)) {
      const payload = match[0];
      try {
        const decoded = Buffer.from(payload, "base64").toString("utf8");
        if (decoded.length >= 20 && /^[\x09\x0A\x0D\x20-\x7E]+$/.test(decoded) && INSTRUCTION_WORDS.test(decoded)) {
          findings.push({
            file,
            line: lineNo,
            kind: "encoded",
            severity: "high",
            rule: "base64-instruction",
            evidence: safeEvidence(line),
          });
        }
      } catch {
        // ignore invalid base64
      }
    }
  }
  return findings;
}

export function stripInvisible(text: string): { text: string; removed: number } {
  let removed = 0;
  const clean = text.replace(new RegExp(HIDDEN_UNICODE.source, "gu"), () => {
    removed += 1;
    return "";
  });
  return { text: clean, removed };
}

export function scanInjection(cwd: string, options: InjectionOptions = {}): InjectionReport {
  const limit = Math.max(1, Math.min(MAX_FILES, options.maxFiles ?? MAX_FILES));
  const files = listFiles(cwd, limit)
    .filter((file) => !pathMatches(file, options.exclude))
    .filter((file) => (options.include && options.include.length > 0 ? pathMatches(file, options.include) : true));
  const findings: InjectionFinding[] = [];
  let scanned = 0;

  for (const file of files) {
    const full = resolve(cwd, file);
    if (!existsSync(full)) continue;
    let size = 0;
    try {
      size = statSync(full).size;
    } catch {
      continue;
    }
    if (size > MAX_FILE_BYTES) continue;
    let text = "";
    try {
      text = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue;
    scanned += 1;
    findings.push(...scanText(file, text));
  }

  findings.sort(
    (left, right) =>
      SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity] ||
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.rule.localeCompare(right.rule),
  );
  const counts: Record<InjectionSeverity, number> = { high: 0, medium: 0, low: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  const summary =
    findings.length === 0
      ? "Prompt-injection не найдено."
      : `Найдено потенциальных prompt-injection: ${String(findings.length)} (high ${String(counts.high)}, medium ${String(counts.medium)}, low ${String(counts.low)}).`;
  const content = [
    `Injection scan: ${String(scanned)} file(s), ${String(findings.length)} finding(s)`,
    ...findings.map(
      (finding) =>
        `[${finding.severity.toUpperCase()}] ${finding.file}:${String(finding.line)} ${finding.kind} (${finding.rule}) — ${finding.evidence}`,
    ),
    summary,
  ].join("\n");
  return { files: scanned, findings, counts, summary, content: `${content}\n` };
}

export function renderInjection(report: InjectionReport): string {
  return report.content;
}

export function fixInjection(cwd: string, options: InjectionOptions = {}): InjectionFixResult {
  const limit = Math.max(1, Math.min(MAX_FILES, options.maxFiles ?? MAX_FILES));
  const files = listFiles(cwd, limit)
    .filter((file) => !pathMatches(file, options.exclude))
    .filter((file) => (options.include && options.include.length > 0 ? pathMatches(file, options.include) : true));
  let fixed = 0;
  let removed = 0;
  for (const file of files) {
    const full = resolve(cwd, file);
    if (!existsSync(full)) continue;
    if (statSync(full).size > MAX_FILE_BYTES) continue;
    const text = readFileSync(full, "utf8");
    if (text.includes("\0")) continue;
    const clean = stripInvisible(text);
    if (clean.removed > 0) {
      writeFileSync(full, clean.text, "utf8");
      fixed += 1;
      removed += clean.removed;
    }
  }
  return { files: fixed, removed };
}

export function severityAtLeast(value: InjectionSeverity, threshold: InjectionSeverity): boolean {
  return SEVERITY_RANK[value] >= SEVERITY_RANK[threshold];
}

export function parseInjectionSeverity(raw: string | undefined): InjectionSeverity {
  if (raw === undefined || raw.trim() === "") return "high";
  if (raw === "high" || raw === "medium" || raw === "low") return raw;
  throw new PilotError(`Некорректный порог severity: ${raw}`, {
    hint: "Используйте high, medium или low.",
    exitCode: 2,
  });
}

export { describeInjectionFindings, scanDiffForInjection } from "./injection-diff.js";
export type { DiffInjectionFinding } from "./injection-diff.js";
