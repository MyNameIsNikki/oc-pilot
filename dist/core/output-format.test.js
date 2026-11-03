import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseFindings, normalizeLocation } from "./findings.js";
import { validateAnalysis } from "./format.js";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES = join(ROOT, "test", "fixtures", "model-output");
/**
 * Realistic model replies, captured once and replayed. A model or prompt change
 * must not silently change what the CLI reports, so every case pins severity,
 * location and the gist of the text.
 */
const CASES = [
    {
        file: "review-en-canonical.md",
        recipe: "review",
        findings: [
            { severity: "critical", location: "wallet.go:10", contains: "nil check" },
            { severity: "warning", location: "wallet.go:11", contains: "negative" },
        ],
        warnings: [],
    },
    {
        file: "review-ru-canonical.md",
        recipe: "review",
        findings: [
            { severity: "critical", location: "wallet.go:10", contains: "nil" },
            { severity: "warning", location: "wallet.go:11", contains: "amount" },
        ],
        warnings: [],
    },
    {
        file: "review-ru-ranges.md",
        recipe: "review",
        findings: [
            { severity: "critical", location: "wallet.go:10", contains: "указателя" },
            { severity: "warning", location: "src/api/handler.ts:42", contains: "аргумент" },
            { severity: "style", location: "src/app.ts:12", contains: "имя переменной" },
        ],
        warnings: [],
    },
    {
        file: "review-fenced-code.md",
        recipe: "review",
        findings: [{ severity: "critical", location: "src/config.ts:7", contains: "timeout" }],
        warnings: [],
    },
    { file: "review-lgtm-en.md", recipe: "review", findings: [], warnings: [] },
    { file: "review-lgtm-ru.md", recipe: "review", findings: [], warnings: [] },
    {
        file: "review-missing-solution.md",
        recipe: "review",
        findings: [{ severity: "critical", location: "db/migrate.ts:88", contains: "transaction" }],
        warnings: ["missing-solution"],
    },
    { file: "review-unstructured.md", recipe: "review", findings: [], warnings: ["missing-analysis", "missing-findings", "missing-solution"] },
    { file: "review-notes-without-severity.md", recipe: "review", findings: [], warnings: [] },
    {
        file: "review-preamble.md",
        recipe: "review",
        findings: [{ severity: "critical", location: "src/db/users.ts:88", contains: "SQL" }],
        warnings: [],
    },
];
function fixture(file) {
    return readFileSync(join(FIXTURES, file), "utf8");
}
for (const item of CASES) {
    test(`model output ${item.file} keeps its findings and format warnings`, () => {
        const text = fixture(item.file);
        const findings = parseFindings(text);
        assert.equal(findings.length, item.findings.length, `findings count for ${item.file}`);
        item.findings.forEach((expected, index) => {
            const actual = findings[index];
            assert.equal(actual.severity, expected.severity, `severity #${index + 1}`);
            assert.equal(actual.location, expected.location, `location #${index + 1}`);
            assert.ok(actual.text.toLowerCase().includes(expected.contains.toLowerCase()), `text #${index + 1} should mention "${expected.contains}", got "${actual.text}"`);
        });
        assert.deepEqual(validateAnalysis(text, item.recipe).map((warning) => warning.code), item.warnings, `warnings for ${item.file}`);
    });
}
test("normalizeLocation collapses the shapes models actually emit", () => {
    const cases = [
        ["wallet.go:10", "wallet.go:10"],
        ["wallet.go:10:5", "wallet.go:10:5"],
        ["src/a.ts:10-14", "src/a.ts:10"],
        ["src/a.ts:10,12", "src/a.ts:10"],
        ["src/a.ts#L12", "src/a.ts:12"],
        ["src/a.ts#L12-L18", "src/a.ts:12"],
        ["src/a.ts (line 12)", "src/a.ts:12"],
        ["src/a.ts строка 12", "src/a.ts:12"],
        [".\\src\\a.ts:7", "src/a.ts:7"],
        ["src/a.ts", "src/a.ts"],
        ["   ", undefined],
    ];
    for (const [input, expected] of cases) {
        assert.equal(normalizeLocation(input), expected, `normalizeLocation(${JSON.stringify(input)})`);
    }
});
//# sourceMappingURL=output-format.test.js.map