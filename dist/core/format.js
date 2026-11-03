export function validateAnalysis(text, recipe) {
    if (recipe === "commit")
        return [];
    if (recipe === "review" &&
        /^LGTM:\s*(?:критических проблем не обнаружено|no critical issues found)\.?\s*$/im.test(text)) {
        return [];
    }
    const warnings = [];
    if (!/^###\s+(?:Анализ|Analysis)\s*:?/m.test(text)) {
        warnings.push({ code: "missing-analysis", message: "отсутствует заголовок `### Анализ:` / `### Analysis:`" });
    }
    if (!/^####\s+(?:Замечания|Findings)(?:\s*\/\s*(?:Действия|Actions))?(?=\s|:|$)/m.test(text)) {
        warnings.push({
            code: "missing-findings",
            message: "отсутствует заголовок `#### Замечания / Действия` / `#### Findings / Actions`",
        });
    }
    if (!/^####\s+(?:Решение|Исправление|Solution|Fix)(?=\s|:|$)/m.test(text)) {
        warnings.push({ code: "missing-solution", message: "отсутствует заголовок `#### Решение` / `#### Solution`" });
    }
    return warnings;
}
export function buildJsonAnalysis(analysisText, secrets, meta, findings = []) {
    return {
        recipe: meta.recipe,
        projectType: meta.projectType,
        analysis: analysisText,
        findings,
        secrets,
        meta,
    };
}
//# sourceMappingURL=format.js.map