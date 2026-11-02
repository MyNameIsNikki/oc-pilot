import type { AnalysisFinding, Recipe, SecretFinding } from "../types.js";

export interface FormatWarning {
  code: "missing-analysis" | "missing-findings" | "missing-solution";
  message: string;
}

export function validateAnalysis(text: string, recipe: Recipe): FormatWarning[] {
  if (recipe === "commit") return [];
  if (
    recipe === "review" &&
    /^LGTM:\s*(?:критических проблем не обнаружено|no critical issues found)\.?\s*$/im.test(text)
  ) {
    return [];
  }

  const warnings: FormatWarning[] = [];
  if (!/^###\s+(?:Анализ|Analysis)\s*:/m.test(text)) {
    warnings.push({ code: "missing-analysis", message: "отсутствует заголовок `### Анализ:` / `### Analysis:`" });
  }
  if (!/^####\s+(?:Замечания\s*\/\s*Действия|Findings\s*\/\s*Actions)/m.test(text)) {
    warnings.push({
      code: "missing-findings",
      message: "отсутствует заголовок `#### Замечания / Действия` / `#### Findings / Actions`",
    });
  }
  if (!/^####\s+(?:Решение|Solution)/m.test(text)) {
    warnings.push({ code: "missing-solution", message: "отсутствует заголовок `#### Решение` / `#### Solution`" });
  }
  return warnings;
}

export interface AnalysisMeta {
  recipe: Recipe;
  projectType: string;
  agent: string;
  model: string | null;
  durationMs: number;
  filesChanged: number;
  sessionID?: string;
  cost?: number;
  formatValid: boolean;
  formatWarnings: string[];
  [key: string]: unknown;
}

export interface JsonAnalysis {
  recipe: Recipe;
  projectType: string;
  analysis: string;
  findings: AnalysisFinding[];
  secrets: SecretFinding[];
  meta: AnalysisMeta;
}

export function buildJsonAnalysis(
  analysisText: string,
  secrets: SecretFinding[],
  meta: AnalysisMeta,
  findings: AnalysisFinding[] = [],
): JsonAnalysis {
  return {
    recipe: meta.recipe,
    projectType: meta.projectType,
    analysis: analysisText,
    findings,
    secrets,
    meta,
  };
}
