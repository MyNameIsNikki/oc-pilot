import { parseGitPath } from "./diff.js";
const RULES = [
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
        pattern: /(?:api[_-]?key|secret(?:[_-]?key)?|token|password|passwd|pwd|access[_-]?key|auth(?:orization)?)\s*[:=]\s*['"`]([^'"`\s]{8,})['"`]/gi,
        captureGroup: 1,
    },
    {
        kind: "Dotenv secret assignment",
        severity: "warning",
        pattern: /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY)[A-Za-z0-9_]*\s*=\s*([^\s#]{8,})\s*$/gim,
        captureGroup: 1,
    },
];
function isPlaceholder(value) {
    const trimmed = value.trim();
    if (trimmed.length < 8)
        return true;
    if (/^(?:x{3,}|\*{3,}|\.{3,}|<[^>]*>|%\([^)]*\)s|\{\{[^}]*\}\})$/i.test(trimmed))
        return true;
    if (/^\$\{[^}]*\}$/.test(trimmed) || /^\$[A-Z_][A-Z0-9_]*$/i.test(trimmed))
        return true;
    if (/^(?:process\.env|os\.environ|env\.|import\.meta\.env)/.test(trimmed))
        return true;
    if (/^(?:example|sample|dummy|fake|test|changeme|change_me|placeholder|secret|password|token|redacted|your[_-]?.*)$/i.test(trimmed)) {
        return true;
    }
    if (/^[A-Z][A-Z0-9_]{2,}$/.test(trimmed) && !/\d/.test(trimmed))
        return true;
    return false;
}
function redactValue(raw, kind) {
    if (kind === "Private key")
        return "-----BEGIN … PRIVATE KEY-----";
    if (raw.length <= 8)
        return "***";
    return `${raw.slice(0, 4)}…${raw.slice(-4)}`;
}
function marker(kind) {
    return `[REDACTED:${kind}]`;
}
function scanLine(line, file, lineNumber, seen) {
    const findings = [];
    let redactedLine = line;
    const isPrivateKeyHeader = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/.test(line);
    const isPrivateKeyFooter = /-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/.test(line);
    for (const rule of RULES) {
        const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
        for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
            const raw = rule.captureGroup === undefined ? match[0] : match[rule.captureGroup];
            if (!raw || isPlaceholder(raw))
                continue;
            const dedupeKey = `${file}:${lineNumber}:${raw}`;
            if (seen.has(dedupeKey))
                continue;
            seen.add(dedupeKey);
            findings.push({
                file,
                line: lineNumber,
                kind: rule.kind,
                severity: rule.severity,
                preview: redactValue(raw, rule.kind),
                raw,
            });
            if (redactedLine.includes(raw)) {
                redactedLine = redactedLine.split(raw).join(marker(rule.kind));
            }
        }
    }
    return { findings, redactedLine, isPrivateKeyHeader, isPrivateKeyFooter };
}
function toPublic(findings) {
    return findings.map(({ file, line, kind, severity, preview }) => ({ file, line, kind, severity, preview }));
}
export function scanText(text, file) {
    const findings = [];
    const seen = new Set();
    const output = [];
    let privateKeyBlock = false;
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const lineNumber = index + 1;
        if (privateKeyBlock) {
            // The header already produced a finding; redact the whole key body.
            output.push(marker("Private key block"));
            if (/-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/.test(line))
                privateKeyBlock = false;
            continue;
        }
        const scanned = scanLine(line, file, lineNumber, seen);
        if (scanned.isPrivateKeyHeader) {
            privateKeyBlock = !scanned.isPrivateKeyFooter;
            findings.push(...scanned.findings);
            output.push(marker("Private key block"));
        }
        else {
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
export function scanDiff(diff) {
    const findings = [];
    const seen = new Set();
    const output = [];
    let file = "";
    let newLine = 0;
    let inHunk = false;
    let privateKeyBlock = false;
    for (const line of diff.split("\n")) {
        if (line.startsWith("diff --git ")) {
            file = "";
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
        if (line.startsWith("+")) {
            const content = line.slice(1);
            if (privateKeyBlock) {
                // The header already produced a finding; redact the whole key body.
                output.push(`+${marker("Private key block")}`);
                if (/-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/.test(content)) {
                    privateKeyBlock = false;
                }
            }
            else {
                const scanned = scanLine(content, file, newLine, seen);
                findings.push(...scanned.findings);
                output.push(scanned.isPrivateKeyHeader ? `+${marker("Private key block")}` : `+${scanned.redactedLine}`);
                if (scanned.isPrivateKeyHeader && !scanned.isPrivateKeyFooter)
                    privateKeyBlock = true;
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
    const unique = new Map();
    for (const finding of findings) {
        const key = `${finding.file}:${finding.line}:${finding.kind}`;
        if (!unique.has(key))
            unique.set(key, finding);
    }
    return { findings: toPublic([...unique.values()]), redacted: output.join("\n") };
}
export function severityIcon(severity) {
    return severity === "critical" ? "🔴" : "🟡";
}
export function formatFindings(findings) {
    return findings.map((finding) => `${severityIcon(finding.severity)} ${finding.file}:${finding.line} — ${finding.kind} (${finding.preview})`);
}
export function findingsForPrompt(findings, redacted, lang = "en") {
    const ru = lang === "ru";
    if (findings.length === 0) {
        return ru
            ? "SECRET_SCAN: чистых добавленных строк с секретами не найдено."
            : "SECRET_SCAN: no secrets found in added lines.";
    }
    const lines = findings.map((finding) => `- [${finding.severity.toUpperCase()}] ${finding.file}:${finding.line} — ${finding.kind} (redacted: ${finding.preview})`);
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
//# sourceMappingURL=secrets.js.map