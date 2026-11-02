import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAnalysis } from "./format.js";

const VALID = `### Анализ: Есть проблема.

#### Замечания / Действия
- **🔴 Critical \`wallet.go:10\`**: nil pointer.

#### Решение
\`\`\`go
func f() {}
\`\`\`
`;

test("validateAnalysis accepts the documented schema", () => {
  assert.deepEqual(validateAnalysis(VALID, "review"), []);
});

test("validateAnalysis accepts the LGTM shortcut for review", () => {
  assert.deepEqual(validateAnalysis("LGTM: критических проблем не обнаружено.", "review"), []);
  assert.notDeepEqual(validateAnalysis("LGTM: критических проблем не обнаружено.", "custom"), []);
});

test("validateAnalysis reports missing sections", () => {
  const warnings = validateAnalysis("Просто текст без структуры", "review");
  assert.equal(warnings.length, 3);
  assert.deepEqual(
    warnings.map((warning) => warning.code),
    ["missing-analysis", "missing-findings", "missing-solution"],
  );
});
