const TRIAGE_LINE = /TRIAGE:\s*(REVIEW|LGTM)\b/i;
export function parseTriageDecision(text) {
    const match = TRIAGE_LINE.exec(text);
    if (!match)
        return "unknown";
    return match[1].toUpperCase() === "LGTM" ? "lgtm" : "review";
}
//# sourceMappingURL=router.js.map