import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PromptLang, SecretFinding, SecretScanResult, SecretSeverity } from "../types.js";
import { parseGitPath } from "./diff.js";

export interface SecretScanOptions {
  /** Paths or simple glob patterns from .oc-pilot/ignore. */
  ignore?: string[];
  /** Enable the Shannon entropy check. Defaults to true. */
  entropy?: boolean;
}

/** Reads .oc-pilot/ignore from the project root. Missing files are valid. */
export function loadSecretIgnore(cwd: string): string[] {
  const path = join(cwd, ".oc-pilot", "ignore");
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  } catch {
    return [];
  }
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    if (char === "*") {
      if (normalized[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function isIgnored(file: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "");
  for (const pattern of patterns) {
    if (!pattern || pattern.startsWith("!")) continue;
    const candidate = pattern.replace(/\\/g, "/");
    if (candidate.endsWith("/")) {
      if (normalized.startsWith(candidate) || normalized.includes(`/${candidate}`)) return true;
      continue;
    }
    const regex = globToRegExp(candidate);
    if (regex.test(normalized)) return true;
    if (!candidate.includes("/") && regex.test(normalized.split("/").pop() ?? "")) return true;
  }
  return false;
}

function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

const ENTROPY_ASSIGNMENT =
  /(?:api[_-]?key|secret(?:[_-]?key)?|token|password|passwd|pwd|access[_-]?key|auth(?:orization)?|private[_-]?key)\s*[:=]\s*['"`]?([A-Za-z0-9+/=_-]{20,})['"`]?/gi;

interface SecretRule {
  kind: string;
  severity: SecretSeverity;
  pattern: RegExp;
  /** 1-based capture group that contains the secret itself. */
  captureGroup?: number;
}

const RULES: SecretRule[] = [
  {
    kind: "Private key",
    severity: "critical",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  {
    kind: "Anthropic API key",
    severity: "critical",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    kind: "OpenAI API key",
    severity: "critical",
    pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/g,
  },
  {
    kind: "AWS Access Key ID",
    severity: "critical",
    pattern: /\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b/g,
  },
  {
    kind: "AWS Secret Access Key",
    severity: "critical",
    pattern: /aws_secret_access_key\s*[:=]\s*['"]([A-Za-z0-9/+=]{40})['"]/gi,
    captureGroup: 1,
  },
  {
    kind: "GitHub token",
    severity: "critical",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g,
  },
  {
    kind: "GitLab token",
    severity: "critical",
    pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    kind: "Slack token",
    severity: "critical",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    kind: "Stripe live key",
    severity: "critical",
    pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g,
  },
  {
    kind: "Google API key",
    severity: "critical",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    kind: "Hugging Face token",
    severity: "critical",
    pattern: /\bhf_[A-Za-z0-9]{30,}\b/g,
  },
  {
    kind: "Groq API key",
    severity: "critical",
    pattern: /\bgsk_[A-Za-z0-9]{40,}\b/g,
  },
  {
    kind: "Discord bot token",
    severity: "critical",
    pattern: /\b(?:mfa\.[A-Za-z0-9_-]{80,}|[MN][A-Za-z0-9]{23}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27})\b/g,
  },
  {
    kind: "SendGrid API key",
    severity: "critical",
    pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g,
  },
  {
    kind: "DigitalOcean token",
    severity: "critical",
    pattern: /\bdop_v1_[a-f0-9]{64}\b/gi,
  },
  {
    kind: "PyPI token",
    severity: "critical",
    pattern: /\bpypi-[A-Za-z0-9_-]{50,}\b/g,
  },
  {
    kind: "Azure Storage account key",
    severity: "critical",
    pattern: /\bAccountKey\s*=\s*([A-Za-z0-9+/=]{40,})/gi,
    captureGroup: 1,
  },
  {
    kind: "npm token",
    severity: "critical",
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
  },
  {
    kind: "Telegram bot token",
    severity: "critical",
    pattern: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g,
  },
  {
    kind: "JWT",
    severity: "warning",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    kind: "Credentials in URL",
    severity: "warning",
    pattern: /\b(?:https?|ftp):\/\/[^/\s:@]+:([^@\s/]{6,})@/gi,
    captureGroup: 1,
  },
  {
    kind: "Generic secret assignment",
    severity: "warning",
    pattern:
      /(?:api[_-]?key|secret(?:[_-]?key)?|token|password|passwd|pwd|access[_-]?key|auth(?:orization)?)\s*[:=]\s*['"`]([^'"`\s]{8,})['"`]/gi,
    captureGroup: 1,
  },
  {
    kind: "Dotenv secret assignment",
    severity: "warning",
    pattern:
      /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY)[A-Za-z0-9_]*\s*=\s*([^\s#]{8,})\s*$/gim,
    captureGroup: 1,
  },
];

function isPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 8) return true;
  if (/^(?:x{3,}|\*{3,}|\.{3,}|<[^>]*>|%\([^)]*\)s|\{\{[^}]*\}\})$/i.test(trimmed)) return true;
  if (/^\$\{[^}]*\}$/.test(trimmed) || /^\$[A-Z_][A-Z0-9_]*$/i.test(trimmed)) return true;
  if (/^(?:process\.env|os\.environ|env\.|import\.meta\.env)/.test(trimmed)) return true;
  if (
    /^(?:example|sample|dummy|fake|test|changeme|change_me|placeholder|secret|password|token|redacted|your[_-]?.*)$/i.test(
      trimmed,
    )
  ) {
    return true;
  }
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(trimmed) && !/\d/.test(trimmed)) return true;
  return false;
}

function redactValue(raw: string, kind: string): string {
  if (kind === "Private key") return "-----BEGIN … PRIVATE KEY-----";
  if (raw.length <= 8) return "***";
  return `${raw.slice(0, 4)}…${raw.slice(-4)}`;
}

function marker(kind: string): string {
  return `[REDACTED:${kind}]`;
}

interface InternalFinding extends SecretFinding {
  raw: string;
}

interface LineScan {
  findings: InternalFinding[];
  redactedLine: string;
  isPrivateKeyHeader: boolean;
  isPrivateKeyFooter: boolean;
}

function scanLine(
  line: string,
  file: string,
  lineNumber: number,
  seen: Set<string>,
  checkEntropy = true,
): LineScan {
  const findings: InternalFinding[] = [];
  let redactedLine = line;
  const criticalRaws = new Set<string>();
  const isPrivateKeyHeader = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/.test(line);
  const isPrivateKeyFooter = /-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/.test(line);

  if (/oc-pilot:ignore-secret/i.test(line)) {
    return { findings: [], redactedLine: line, isPrivateKeyHeader: false, isPrivateKeyFooter: false };
  }

  for (const rule of RULES) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
      const raw = rule.captureGroup === undefined ? match[0] : match[rule.captureGroup];
      if (!raw || isPlaceholder(raw)) continue;

      const dedupeKey = `${file}:${lineNumber}:${raw}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      findings.push({
        file,
        line: lineNumber,
        kind: rule.kind,
        severity: rule.severity,
        preview: redactValue(raw, rule.kind),
        raw,
      });
      if (rule.severity === "critical") criticalRaws.add(raw);

      if (redactedLine.includes(raw)) {
        redactedLine = redactedLine.split(raw).join(marker(rule.kind));
      }
    }
  }

  if (checkEntropy) {
    const pattern = new RegExp(ENTROPY_ASSIGNMENT.source, ENTROPY_ASSIGNMENT.flags);
    for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
      const raw = match[1];
      if (!raw || raw.length < 20 || isPlaceholder(raw) || shannonEntropy(raw) < 4) continue;
      // A precise critical rule already covers this value; entropy would only duplicate it.
      if (criticalRaws.has(raw)) continue;
      // Values caught by a generic (warning) rule are upgraded to critical here.
      findings.push({
        file,
        line: lineNumber,
        kind: "High-entropy secret",
        severity: "critical",
        preview: redactValue(raw, "High-entropy secret"),
        raw,
      });
      if (redactedLine.includes(raw)) {
        redactedLine = redactedLine.split(raw).join(marker("High-entropy secret"));
      }
    }
  }

  return { findings, redactedLine, isPrivateKeyHeader, isPrivateKeyFooter };
}

function toPublic(findings: InternalFinding[]): SecretFinding[] {
  return findings.map(({ file, line, kind, severity, preview }) => ({ file, line, kind, severity, preview }));
}

export function scanText(text: string, file: string, options: SecretScanOptions = {}): SecretScanResult {
  if (isIgnored(file, options.ignore ?? [])) return { findings: [], redacted: text };
  const findings: InternalFinding[] = [];
  const seen = new Set<string>();
  const output: string[] = [];
  let privateKeyBlock = false;

  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const lineNumber = index + 1;

    if (privateKeyBlock) {
      // The header already produced a finding; redact the whole key body.
      output.push(marker("Private key block"));
      if (/-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/.test(line)) privateKeyBlock = false;
      continue;
    }

    const scanned = scanLine(line, file, lineNumber, seen, options.entropy !== false);
    if (scanned.isPrivateKeyHeader) {
      privateKeyBlock = !scanned.isPrivateKeyFooter;
      findings.push(...scanned.findings);
      output.push(marker("Private key block"));
    } else {
      findings.push(...scanned.findings);
      output.push(scanned.redactedLine);
    }
  }

  return { findings: toPublic(findings), redacted: output.join("\n") };
}

/**
 * Scans only added lines of a unified diff, preserves hunk line numbers, and
 * returns a copy of the diff with secrets replaced by markers.
 */
export function scanDiff(diff: string, options: SecretScanOptions = {}): SecretScanResult {
  const findings: InternalFinding[] = [];
  const seen = new Set<string>();
  const output: string[] = [];
  let file = "";
  let ignored = false;
  let newLine = 0;
  let inHunk = false;
  let privateKeyBlock = false;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = "";
      ignored = false;
      newLine = 0;
      inHunk = false;
      privateKeyBlock = false;
      output.push(line);
      continue;
    }

    // File headers live outside hunks. Inside a hunk a line such as "+++ foo"
    // is an added line whose content starts with "++".
    if (!inHunk && line.startsWith("+++ ")) {
      const path = parseGitPath(line.slice(4));
      file = path === "/dev/null" ? "" : path;
      ignored = isIgnored(file, options.ignore ?? []);
      output.push(line);
      continue;
    }

    if (line.startsWith("@@ ")) {
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      newLine = match ? Number(match[1]) : 0;
      inHunk = true;
      output.push(line);
      continue;
    }

    if (!inHunk || !file) {
      output.push(line);
      continue;
    }

    if (ignored) {
      if (line.startsWith("+")) newLine += 1;
      output.push(line);
      continue;
    }

    if (line.startsWith("+")) {
      const content = line.slice(1);
      if (privateKeyBlock) {
        // The header already produced a finding; redact the whole key body.
        output.push(`+${marker("Private key block")}`);
        if (/-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/.test(content)) {
          privateKeyBlock = false;
        }
      } else {
        const scanned = scanLine(content, file, newLine, seen, options.entropy !== false);
        findings.push(...scanned.findings);
        output.push(scanned.isPrivateKeyHeader ? `+${marker("Private key block")}` : `+${scanned.redactedLine}`);
        if (scanned.isPrivateKeyHeader && !scanned.isPrivateKeyFooter) privateKeyBlock = true;
      }
      newLine += 1;
      continue;
    }

    if (line.startsWith("-")) {
      output.push(line);
      continue;
    }

    if (line.startsWith("\\ No newline")) {
      output.push(line);
      continue;
    }

    if (line.startsWith(" ")) {
      if (privateKeyBlock && /-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/.test(line)) {
        privateKeyBlock = false;
      }
      output.push(line);
      newLine += 1;
      continue;
    }

    output.push(line);
  }

  // A BEGIN line was consumed by scanLine; make sure its finding is also kept
  // when the header is not the first line of the block.
  const unique = new Map<string, InternalFinding>();
  for (const finding of findings) {
    const key = `${finding.file}:${finding.line}:${finding.kind}`;
    if (!unique.has(key)) unique.set(key, finding);
  }

  return { findings: toPublic([...unique.values()]), redacted: output.join("\n") };
}

export function severityIcon(severity: SecretSeverity): string {
  return severity === "critical" ? "🔴" : "🟡";
}

export function formatFindings(findings: SecretFinding[]): string[] {
  return findings.map(
    (finding) => `${severityIcon(finding.severity)} ${finding.file}:${finding.line} — ${finding.kind} (${finding.preview})`,
  );
}

export function findingsForPrompt(
  findings: SecretFinding[],
  redacted: boolean,
  lang: PromptLang = "en",
): string {
  const ru = lang === "ru";
  if (findings.length === 0) {
    return ru
      ? "SECRET_SCAN: чистых добавленных строк с секретами не найдено."
      : "SECRET_SCAN: no secrets found in added lines.";
  }

  const lines = findings.map(
    (finding) =>
      `- [${finding.severity.toUpperCase()}] ${finding.file}:${finding.line} — ${finding.kind} (redacted: ${finding.preview})`,
  );

  return [
    ru
      ? `SECRET_SCAN: найдено ${findings.length} потенциальных секретов в добавленных строках.`
      : `SECRET_SCAN: found ${findings.length} potential secret(s) in added lines.`,
    redacted
      ? ru
        ? "Значения заменены маркерами [REDACTED:<kind>] перед отправкой модели."
        : "Values were replaced with [REDACTED:<kind>] markers before sending to the model."
      : ru
        ? "ВНИМАНИЕ: redaction отключён, значения могут присутствовать в diff."
        : "WARNING: redaction is disabled; values may be present in the diff.",
    ...lines,
    ru
      ? "Обязательно отрази каждую находку в замечаниях как 🔴 Critical и порекомендуй отозвать ключ и очистить историю git."
      : "Report every finding in the findings section as 🔴 Critical and recommend revoking the key and cleaning git history.",
  ].join("\n");
}
