import assert from "node:assert/strict";
import { test } from "node:test";
import { countFindings, parseFailOn, parseFindings, shouldFail } from "./findings.js";
const ANALYSIS = `### Анализ: Найдены проблемы.

#### Замечания / Действия
- **🔴 Critical \`wallet.go:10\`**: nil pointer dereference.
- **🟡 Warning \`wallet.go:11\`**: balance can become negative.
- **🔵 Style \`wallet.go:12\`**: rename the variable.
- **🔴 Critical**: no location here.

#### Решение
\`\`\`go
func f() {}
\`\`\`
`;
test("parseFindings extracts severity, location and text", () => {
    const findings = parseFindings(ANALYSIS);
    assert.equal(findings.length, 4);
    assert.deepEqual(findings[0], {
        severity: "critical",
        location: "wallet.go:10",
        text: "nil pointer dereference.",
    });
    assert.equal(findings[1]?.severity, "warning");
    assert.equal(findings[1]?.location, "wallet.go:11");
    assert.equal(findings[2]?.severity, "style");
    assert.equal(findings[2]?.text, "rename the variable.");
    assert.equal(findings[3]?.location, undefined);
    assert.deepEqual(countFindings(findings), { critical: 2, warning: 1, style: 1 });
});
test("parseFindings accepts Russian severity labels", () => {
    const findings = parseFindings(`### Анализ: x

#### Замечания / Действия
- **Критично \`a.go:1\`**: сломан контракт.
- **Предупреждение**: медленно.
`);
    assert.equal(findings.length, 2);
    assert.equal(findings[0]?.severity, "critical");
    assert.equal(findings[1]?.severity, "warning");
});
test("parseFindings ignores the LGTM shortcut and empty sections", () => {
    assert.deepEqual(parseFindings("LGTM: критических проблем не обнаружено."), []);
    assert.deepEqual(parseFindings("### Анализ: x\n\n#### Решение\nкод"), []);
});
test("shouldFail applies the configured threshold", () => {
    const findings = parseFindings(ANALYSIS);
    assert.equal(shouldFail(findings, "none"), false);
    assert.equal(shouldFail(findings, "style"), true);
    assert.equal(shouldFail(findings, "warning"), true);
    assert.equal(shouldFail(findings, "critical"), true);
    assert.equal(shouldFail([{ severity: "style", text: "x" }], "warning"), false);
    assert.equal(shouldFail([], "critical"), false);
});
test("parseFailOn accepts aliases and rejects unknown values", () => {
    assert.equal(parseFailOn("warn"), "warning");
    assert.equal(parseFailOn("note"), "style");
    assert.equal(parseFailOn("off"), "none");
    assert.throws(() => parseFailOn("fatal"), /неизвестный уровень/);
});
//# sourceMappingURL=findings.test.js.map