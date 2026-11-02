import { relative } from "node:path";
import { VERSION } from "../version.js";
export const SARIF_VERSION = "2.1.0";
export const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";
export const SECRET_RULE_ID = "oc-pilot/secret";
export const CRITICAL_RULE_ID = "oc-pilot/critical";
export const WARNING_RULE_ID = "oc-pilot/warning";
const RULES = [
    {
        id: SECRET_RULE_ID,
        name: "SecretLeak",
        shortDescription: { text: "Potential secret detected in added lines of the diff" },
        defaultConfiguration: { level: "error" },
    },
    {
        id: CRITICAL_RULE_ID,
        name: "CriticalFinding",
        shortDescription: { text: "Critical problem reported by oc-pilot review" },
        defaultConfiguration: { level: "error" },
    },
    {
        id: WARNING_RULE_ID,
        name: "WarningFinding",
        shortDescription: { text: "Warning reported by oc-pilot review" },
        defaultConfiguration: { level: "warning" },
    },
];
function toResult(input) {
    const result = {
        ruleId: input.ruleId,
        level: input.level,
        message: { text: input.message },
    };
    if (input.file) {
        result.locations = [
            {
                physicalLocation: {
                    artifactLocation: { uri: input.file.replace(/\\/g, "/") },
                    region: { startLine: input.line && input.line > 0 ? input.line : 1 },
                },
            },
        ];
    }
    return result;
}
/** Builds a SARIF 2.1.0 log for GitHub Code Scanning. */
export function buildSarif(results) {
    return {
        $schema: SARIF_SCHEMA,
        version: SARIF_VERSION,
        runs: [
            {
                tool: {
                    driver: {
                        name: "oc-pilot",
                        informationUri: "https://github.com/MyNameIsNikki/oc-pilot",
                        version: VERSION,
                        rules: RULES,
                    },
                },
                results: results.map(toResult),
            },
        ],
    };
}
/** Maps offline secret-scan findings to SARIF results. Previews are redacted. */
export function secretFindingsToSarifResults(findings) {
    return findings.map((finding) => ({
        ruleId: SECRET_RULE_ID,
        level: finding.severity === "critical" ? "error" : "warning",
        message: `${finding.kind} in added line (redacted preview: ${finding.preview})`,
        file: finding.file,
        line: finding.line,
    }));
}
function normalizeLocation(location, cwd) {
    if (!location)
        return {};
    const match = /^(.*?):(\d+)(?::\d+)?$/.exec(location);
    if (!match)
        return {};
    const rawFile = match[1];
    let file = rawFile;
    if (/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(rawFile)) {
        const rel = relative(cwd, rawFile);
        file = rel.startsWith("..") ? rawFile : rel;
    }
    return { file: file || undefined, line: Number(match[2]) };
}
/** Maps parsed model findings (review) to SARIF results. */
export function analysisFindingsToSarifResults(findings, cwd) {
    const results = [];
    for (const finding of findings) {
        const { file, line } = normalizeLocation(finding.location, cwd);
        if (finding.severity === "critical") {
            results.push({
                ruleId: CRITICAL_RULE_ID,
                level: "error",
                message: finding.text,
                file,
                line,
            });
        }
        else if (finding.severity === "warning") {
            results.push({
                ruleId: WARNING_RULE_ID,
                level: "warning",
                message: finding.text,
                file,
                line,
            });
        }
        else {
            results.push({
                ruleId: WARNING_RULE_ID,
                level: "note",
                message: finding.text,
                file,
                line,
            });
        }
    }
    return results;
}
//# sourceMappingURL=sarif.js.map