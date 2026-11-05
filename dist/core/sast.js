import { SARIF_SCHEMA, SARIF_VERSION } from "./sarif.js";
import { VERSION } from "../version.js";
/**
 * Deterministic rules, not a model. Each sink is a call that becomes dangerous
 * when a request-derived value reaches it; `taint` keeps the rules quiet on
 * constant arguments.
 */
const RULES = [
    {
        id: "command-injection",
        severity: "high",
        message: "request data reaches a shell command; use execFile/spawn with an argument array",
        sink: /\b(?:exec|execSync)\s*\(/,
    },
    {
        id: "shell-true",
        severity: "medium",
        message: "spawn with shell:true turns arguments into shell syntax",
        sink: /\bshell\s*:\s*true\b/,
        taint: false,
    },
    {
        id: "sql-injection",
        severity: "high",
        message: "request data is concatenated into a SQL query; use placeholders",
        sink: /\.(?:query|execute|raw)\s*\(/,
    },
    {
        id: "path-traversal",
        severity: "high",
        message: "request data reaches the filesystem; resolve and confine the path first",
        sink: /\b(?:readFile|readFileSync|writeFile|writeFileSync|createReadStream|createWriteStream|unlink|unlinkSync|rm|rmSync)\s*\(/,
    },
    {
        id: "ssrf",
        severity: "high",
        message: "request data becomes an outbound URL; allowlist hosts before the request",
        sink: /\b(?:fetch|axios\.(?:get|post|put|delete)|got|request)\s*\(/,
    },
    {
        id: "code-injection",
        severity: "high",
        message: "request data is evaluated as code",
        sink: /\beval\s*\(|\bnew\s+Function\s*\(|\bvm\.runIn(?:NewContext|ThisContext|Context)\s*\(/,
    },
    {
        id: "xss",
        severity: "high",
        message: "request data is written as HTML without escaping",
        sink: /\.innerHTML\s*=|\bdangerouslySetInnerHTML\b/,
    },
    {
        id: "open-redirect",
        severity: "medium",
        message: "request data controls a redirect target; allowlist paths",
        sink: /\bres\.redirect\s*\(/,
    },
    {
        id: "tls-verification",
        severity: "high",
        message: "TLS certificate verification is disabled",
        sink: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0/,
        taint: false,
    },
    {
        id: "cors-wildcard",
        severity: "low",
        message: "wildcard CORS origin exposes the endpoint to any site",
        sink: /origin\s*:\s*["']\*["']/,
        taint: false,
    },
    {
        id: "prototype-pollution",
        severity: "medium",
        message: "request data is merged into an object without key filtering",
        sink: /Object\.assign\s*\(\s*[^,]+,\s*(?:req|request)\.|\.merge\s*\(\s*[^,]+,\s*(?:req|request)\./,
        taint: false,
    },
    {
        id: "weak-hash",
        severity: "low",
        message: "MD5/SHA-1 are not collision resistant; use SHA-256 or better",
        sink: /createHash\s*\(\s*["'](?:md5|sha1)["']/i,
        taint: false,
    },
    {
        id: "jwt-none",
        severity: "high",
        message: "the JWT 'none' algorithm accepts unsigned tokens",
        sink: /algorithms\s*:\s*\[[^\]]*["']none["']/i,
        taint: false,
    },
];
const TAINT = /\b(?:req|request)\.(?:query|body|params|headers|cookies)\b|\buserInput\b|\buntrusted\w*\b|\b(?:query|body|params)\.\w+/;
const SANITIZER = /\bpath\.(?:resolve|normalize|basename|join)\b/;
const SUPPRESSION = /oc-pilot:sast-ignore(?:\s+([\w-]+))?\s*:\s*(\S.*)$/;
const SEVERITY_RANK = { low: 1, medium: 2, high: 3 };
export function severityAtLeast(value, threshold) {
    return SEVERITY_RANK[value] >= SEVERITY_RANK[threshold];
}
export function parseSastSeverity(value) {
    const normalized = value.trim().toLowerCase();
    return normalized === "high" || normalized === "medium" || normalized === "low" ? normalized : undefined;
}
/** Removes comments but keeps string contents: SQL and HTML sinks live in strings. */
export function stripComments(text) {
    let out = "";
    let state = "code";
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1];
        if (state === "code") {
            if (char === "/" && next === "/") {
                state = "line";
                out += "  ";
                index += 1;
                continue;
            }
            if (char === "/" && next === "*") {
                state = "block";
                out += "  ";
                index += 1;
                continue;
            }
            if (char === "'")
                state = "single";
            else if (char === '"')
                state = "double";
            else if (char === "`")
                state = "template";
            out += char;
            continue;
        }
        if (state === "line") {
            if (char === "\n") {
                state = "code";
                out += char;
            }
            else {
                out += " ";
            }
            continue;
        }
        if (state === "block") {
            if (char === "*" && next === "/") {
                state = "code";
                out += "  ";
                index += 1;
            }
            else {
                out += char === "\n" ? "\n" : " ";
            }
            continue;
        }
        if (char === "\\") {
            out += char + (next ?? "");
            index += 1;
            continue;
        }
        if ((state === "single" && char === "'") || (state === "double" && char === '"') || (state === "template" && char === "`")) {
            state = "code";
        }
        out += char;
    }
    return out;
}
function lineStarts(text) {
    const starts = [0];
    for (let index = 0; index < text.length; index += 1) {
        if (text[index] === "\n")
            starts.push(index + 1);
    }
    return starts;
}
function locate(starts, offset) {
    let low = 0;
    let high = starts.length - 1;
    while (low <= high) {
        const middle = (low + high) >> 1;
        if (starts[middle] <= offset)
            low = middle + 1;
        else
            high = middle - 1;
    }
    const lineIndex = Math.max(0, high);
    return { line: lineIndex + 1, column: offset - starts[lineIndex] + 1 };
}
function suppressionAt(lines, lineIndex, rule) {
    for (const index of [lineIndex, lineIndex - 1]) {
        const line = lines[index];
        if (!line)
            continue;
        const match = line.match(SUPPRESSION);
        if (!match)
            continue;
        const scopedRule = match[1];
        const reason = match[2]?.trim() ?? "";
        if (reason.length < 3)
            continue;
        if (scopedRule && scopedRule !== rule)
            continue;
        return true;
    }
    return false;
}
/**
 * Scans one source file. The rules are intentionally conservative: a sink is
 * reported only when request-derived data appears in the same expression.
 */
export function scanSource(file, text, options = {}) {
    const clean = stripComments(text);
    const starts = lineStarts(clean);
    const lines = text.split(/\r?\n/);
    const findings = [];
    const seen = new Set();
    let suppressed = 0;
    for (const rule of RULES) {
        const pattern = new RegExp(rule.sink.source, rule.sink.flags.includes("g") ? rule.sink.flags : `${rule.sink.flags}g`);
        for (let match = pattern.exec(clean); match; match = pattern.exec(clean)) {
            const offset = match.index ?? 0;
            const window = clean.slice(offset, offset + 260);
            if (rule.taint !== false && !TAINT.test(window))
                continue;
            if (rule.id === "path-traversal" && SANITIZER.test(window))
                continue;
            const { line, column } = locate(starts, offset);
            const key = `${rule.id}:${String(line)}:${String(column)}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            if (options.suppressions !== false && suppressionAt(lines, line - 1, rule.id)) {
                suppressed += 1;
                continue;
            }
            findings.push({
                rule: rule.id,
                severity: rule.severity,
                file,
                line,
                column,
                message: rule.message,
                snippet: (lines[line - 1] ?? "").trim().slice(0, 200),
            });
        }
    }
    findings.sort((a, b) => a.line - b.line || a.column - b.column || a.rule.localeCompare(b.rule));
    return { findings, suppressed };
}
export function buildSastReport(files, results) {
    const findings = results.flatMap((result) => result.findings);
    const summary = { high: 0, medium: 0, low: 0 };
    for (const finding of findings)
        summary[finding.severity] += 1;
    return {
        files,
        findings,
        suppressed: results.reduce((total, result) => total + result.suppressed, 0),
        summary,
    };
}
export function renderSast(report) {
    const lines = [
        `Файлов проверено: ${String(report.files)}.`,
        `Найдено: ${String(report.findings.length)} (high ${String(report.summary.high)}, medium ${String(report.summary.medium)}, low ${String(report.summary.low)}), подавлено: ${String(report.suppressed)}.`,
    ];
    if (report.findings.length === 0) {
        lines.push("Проблем не найдено.");
    }
    else {
        for (const finding of report.findings) {
            lines.push(`${finding.severity.toUpperCase().padEnd(6)} ${finding.rule.padEnd(20)} ${finding.file}:${String(finding.line)} — ${finding.message}`);
        }
    }
    return `${lines.join("\n")}\n`;
}
/** SARIF 2.1.0 for code scanning uploads. */
export function sastSarif(report) {
    const levels = {
        high: "error",
        medium: "warning",
        low: "note",
    };
    const rules = [...new Set(report.findings.map((finding) => finding.rule))].map((id) => {
        const finding = report.findings.find((candidate) => candidate.rule === id);
        return {
            id: `oc-pilot/${id}`,
            name: id,
            shortDescription: { text: finding.message },
            defaultConfiguration: { level: levels[finding.severity] },
        };
    });
    const results = report.findings.map((finding) => ({
        ruleId: `oc-pilot/${finding.rule}`,
        level: levels[finding.severity],
        message: { text: `${finding.message}: ${finding.snippet}` },
        locations: [
            {
                physicalLocation: {
                    artifactLocation: { uri: finding.file.replace(/\\/g, "/") },
                    region: { startLine: finding.line, startColumn: finding.column },
                },
            },
        ],
        properties: { severity: finding.severity },
    }));
    return `${JSON.stringify({
        $schema: SARIF_SCHEMA,
        version: SARIF_VERSION,
        runs: [
            {
                tool: {
                    driver: {
                        name: "oc-pilot",
                        informationUri: "https://github.com/oc-pilot/oc-pilot",
                        version: VERSION,
                        rules,
                    },
                },
                results,
            },
        ],
    }, null, 2)}\n`;
}
//# sourceMappingURL=sast.js.map