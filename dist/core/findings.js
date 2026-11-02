const SEVERITY_RANK = {
    critical: 3,
    warning: 2,
    style: 1,
};
const SEVERITY_LABEL = {
    critical: "🔴 Critical",
    warning: "🟡 Warning",
    style: "🔵 Style",
};
export function severityRank(severity) {
    return SEVERITY_RANK[severity];
}
export function severityLabel(severity) {
    return SEVERITY_LABEL[severity];
}
export function parseFailOn(raw) {
    const value = raw.trim().toLowerCase();
    if (value === "none" || value === "off" || value === "false")
        return "none";
    if (value === "critical" || value === "crit" || value === "error")
        return "critical";
    if (value === "warning" || value === "warn")
        return "warning";
    if (value === "style" || value === "note" || value === "any" || value === "all")
        return "style";
    throw new Error(`неизвестный уровень "${raw}" (допустимо: none, critical, warning, style)`);
}
function detectSeverity(text) {
    if (/🔴|critical|критич/i.test(text))
        return "critical";
    if (/🟡|warning|предупрежд/i.test(text))
        return "warning";
    if (/🔵|style|note|стиль|замечан/i.test(text))
        return "style";
    return undefined;
}
function stripMarkdown(value) {
    return value
        .replace(/`/g, "")
        .replace(/\*\*/g, "")
        .replace(/^\s*[-*]\s*/, "")
        .trim();
}
/**
 * Extracts findings from the `#### Замечания / Действия` (or `#### Findings /
 * Actions`) section of an analysis response. The output schema is intentionally
 * simple, but models vary in spacing and emphasis, so the parser is permissive.
 */
export function parseFindings(markdown) {
    const normalized = markdown.replace(/\r\n?/g, "\n");
    if (/LGTM:\s*(?:критических проблем не обнаружено|no critical issues found)/i.test(normalized))
        return [];
    const heading = /^####\s+(?:Замечания\s*\/\s*Действия|Findings\s*\/\s*Actions)\s*$/im.exec(normalized);
    if (!heading)
        return [];
    const start = heading.index + heading[0].length;
    const rest = normalized.slice(start);
    const nextHeading = /^####\s+/m.exec(rest);
    const section = (nextHeading ? rest.slice(0, nextHeading.index) : rest).trim();
    if (!section)
        return [];
    const findings = [];
    for (const line of section.split("\n")) {
        const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
        if (!bullet)
            continue;
        const body = bullet[1].trim();
        const severity = detectSeverity(body);
        if (!severity)
            continue;
        const locationMatch = /`([^`]+)`/.exec(body);
        const location = locationMatch ? locationMatch[1].trim() : undefined;
        let rawText = body;
        if (locationMatch)
            rawText = rawText.replace(locationMatch[0], "");
        let text = stripMarkdown(rawText);
        text = text
            .replace(/^🔴\s*/, "")
            .replace(/^🟡\s*/, "")
            .replace(/^🔵\s*/, "")
            .replace(/^(?:critical|warning|style|note|критич\w*|предупрежд\w*|стиль)(?:\s*\/\s*(?:critical|warning|style|note|критич\w*|предупрежд\w*|стиль))?\s*[:—-]?\s*/i, "")
            .replace(/^\/\s*/, "")
            .replace(/^[:\s—-]+/, "")
            .trim();
        findings.push({ severity, location, text: text || "замечание без описания" });
    }
    return findings;
}
export function countFindings(findings) {
    return {
        critical: findings.filter((finding) => finding.severity === "critical").length,
        warning: findings.filter((finding) => finding.severity === "warning").length,
        style: findings.filter((finding) => finding.severity === "style").length,
    };
}
export function failThreshold(failOn) {
    return failOn === "none" ? 0 : SEVERITY_RANK[failOn];
}
export function shouldFail(findings, failOn) {
    const threshold = failThreshold(failOn);
    if (threshold === 0)
        return false;
    return findings.some((finding) => SEVERITY_RANK[finding.severity] >= threshold);
}
export function describeFindings(findings) {
    const counts = countFindings(findings);
    return `🔴 ${counts.critical} · 🟡 ${counts.warning} · 🔵 ${counts.style}`;
}
//# sourceMappingURL=findings.js.map