import { splitDiffBlocks } from "./diff.js";
import { isCodeFile, isGeneratedPath, isTestFile } from "./slop/source.js";

export type MockLeakKind =
  | "mock-identifier"
  | "mock-comment"
  | "local-path"
  | "test-token"
  | "always-true"
  | "always-false"
  | "localhost-url";

export type MockLeakSeverity = "high" | "medium" | "low";

export interface MockLeak {
  file: string;
  line: number;
  kind: MockLeakKind;
  severity: MockLeakSeverity;
  detail: string;
}

export interface MockLeakReport {
  findings: MockLeak[];
  counts: {
    total: number;
    high: number;
    medium: number;
    low: number;
    byKind: Record<string, number>;
  };
  status: "pass" | "warn" | "fail";
}

const MAX_FINDINGS = 50;

const MOCK_IDENTIFIER = /\b(?:mock|fake|stub|dummy)[A-Z_]\w*\b/;
const MOCK_COMMENT = /(?:\/\/|\/\*|#)\s*.*\b(?:mock|stub|fake|dummy|placeholder|hardcoded|remove before|temporary)\b/i;
const LOCAL_PATH = /(?:[A-Za-z]:[\\/]+Users[\\/]+|\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/)/;
const TEST_TOKEN =
  /\b(?:sk_test_[A-Za-z0-9_]*|pk_test_[A-Za-z0-9_]*|test[_-]?(?:secret|token|key)|dummy[_-]?(?:token|key|secret)|changeme|placeholder[_-]?(?:token|key|secret)|your[_-]?(?:api[_-]?)?key)\b/i;
const ALWAYS_TRUE = /\bif\s*\(\s*true\s*\)/;
const ALWAYS_FALSE = /\bif\s*\(\s*false\s*\)/;
const LOCALHOST_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?/i;

interface Rule {
  kind: MockLeakKind;
  severity: MockLeakSeverity;
  detail: string;
  matches: (line: string) => boolean;
}

const RULES: Rule[] = [
  {
    kind: "local-path",
    severity: "high",
    detail: "локальный путь в прод-коде — замените на конфигурацию или переменную окружения",
    matches: (line) => LOCAL_PATH.test(line),
  },
  {
    kind: "test-token",
    severity: "high",
    detail: "тестовый токен или заглушка вместо настоящего секрета",
    matches: (line) => TEST_TOKEN.test(line),
  },
  {
    kind: "always-true",
    severity: "high",
    detail: "условие всегда истинно — ветка не проверяет реальное состояние",
    matches: (line) => ALWAYS_TRUE.test(line),
  },
  {
    kind: "always-false",
    severity: "high",
    detail: "условие всегда ложно — код под ним недостижим",
    matches: (line) => ALWAYS_FALSE.test(line),
  },
  {
    kind: "mock-identifier",
    severity: "medium",
    detail: "имя похоже на заглушку; проверьте, что в прод не уходит фиктивное значение",
    matches: (line) => MOCK_IDENTIFIER.test(line),
  },
  {
    kind: "localhost-url",
    severity: "medium",
    detail: "localhost в прод-коде — проверьте, что адрес не остался от разработки",
    matches: (line) => LOCALHOST_URL.test(line),
  },
  {
    kind: "mock-comment",
    severity: "low",
    detail: "комментарий помечает заглушку или временное решение",
    matches: (line) => MOCK_COMMENT.test(line),
  },
];

/**
 * Scans only added lines in changed production code. Test files, generated
 * files and documentation are skipped: a mock is expected there.
 */
export function analyzeMockLeaks(diff: string): MockLeakReport {
  const findings: MockLeak[] = [];

  for (const block of splitDiffBlocks(diff)) {
    if (block.path === "(diff)" || block.path === "(unknown)") continue;
    if (!isCodeFile(block.path) || isTestFile(block.path) || isGeneratedPath(block.path)) continue;

    let newLine = 0;
    for (const line of block.text.split(/\r?\n/)) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        newLine = Number(hunk[1]);
        continue;
      }
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) {
        const text = line.slice(1);
        for (const rule of RULES) {
          if (!rule.matches(text)) continue;
          findings.push({
            file: block.path,
            line: newLine,
            kind: rule.kind,
            severity: rule.severity,
            detail: rule.detail,
          });
          break;
        }
      }
      if (line.startsWith("+") || line.startsWith(" ") || line === "") newLine += 1;
    }
  }

  const counts = {
    total: findings.length,
    high: findings.filter((finding) => finding.severity === "high").length,
    medium: findings.filter((finding) => finding.severity === "medium").length,
    low: findings.filter((finding) => finding.severity === "low").length,
    byKind: findings.reduce<Record<string, number>>((accumulator, finding) => {
      accumulator[finding.kind] = (accumulator[finding.kind] ?? 0) + 1;
      return accumulator;
    }, {}),
  };

  return {
    findings: findings.slice(0, MAX_FINDINGS),
    counts,
    status: counts.high > 0 ? "fail" : counts.total > 0 ? "warn" : "pass",
  };
}

export function describeMockLeaks(findings: MockLeak[]): string {
  if (findings.length === 0) return "Заглушек и хардкода в изменённом прод-коде не найдено.";
  const lines = findings
    .slice(0, 10)
    .map((finding) => `- ${finding.file}:${String(finding.line)} [${finding.kind}] ${finding.detail}`);
  if (findings.length > 10) lines.push(`- …и ещё ${String(findings.length - 10)}`);
  return lines.join("\n");
}
