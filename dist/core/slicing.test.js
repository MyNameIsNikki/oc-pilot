import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { DEFAULT_CONFIG } from "./config.js";
import { validateAnalysis } from "./format.js";
import { parseFindings } from "./findings.js";
import { executeRecipeDetailed } from "./run.js";
import { mergeSliceAnalyses, planDiffSlices, solutionSection } from "./slicing.js";
import { splitDiffBlocks } from "./diff.js";
function block(path, pad) {
    return `diff --git a/${path} b/${path}\nindex 111..222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n+${"a".repeat(pad)}\n`;
}
test("planDiffSlices groups small blocks into budgeted slices", () => {
    const diff = [block("a.ts", 1_000), block("b.ts", 1_000), block("c.ts", 1_000)].join("");
    const sizes = splitDiffBlocks(diff).map((entry) => entry.text.length);
    const budget = sizes[0] + sizes[1] + 10;
    const plan = planDiffSlices(diff, budget);
    assert.equal(plan.slices.length, 2);
    assert.deepEqual(plan.filesPerSlice, [["a.ts", "b.ts"], ["c.ts"]]);
    assert.deepEqual(plan.oversized, []);
    assert.equal(plan.slices.join(""), diff);
});
test("planDiffSlices clamps tiny budgets instead of dropping blocks", () => {
    const diff = [block("a.ts", 10), block("b.ts", 10)].join("");
    const plan = planDiffSlices(diff, 5);
    assert.equal(plan.slices.length, 1);
    assert.equal(plan.slices.join(""), diff);
    assert.deepEqual(plan.filesPerSlice, [["a.ts", "b.ts"]]);
});
test("planDiffSlices routes oversized blocks to their own slice", () => {
    const diff = [block("small.ts", 50), block("huge.ts", 5_000), block("tiny.ts", 40)].join("");
    const plan = planDiffSlices(diff, 300);
    assert.ok(plan.oversized.includes("huge.ts"));
    const hugeIndex = plan.filesPerSlice.findIndex((files) => files.includes("huge.ts"));
    assert.deepEqual(plan.filesPerSlice[hugeIndex], ["huge.ts"]);
    assert.equal(plan.slices.join(""), diff);
});
test("planDiffSlices returns an empty plan for an empty diff", () => {
    assert.deepEqual(planDiffSlices("", 1_000), { slices: [], filesPerSlice: [], oversized: [] });
});
test("mergeSliceAnalyses collapses all-LGTM slices into one LGTM line", () => {
    const merged = mergeSliceAnalyses(["LGTM: no critical issues found.", "LGTM: no critical issues found."]);
    assert.equal(merged.text, "LGTM: no critical issues found.");
    assert.equal(merged.allLgtm, true);
    assert.equal(merged.sliceCount, 2);
    assert.deepEqual(validateAnalysis(merged.text, "review"), []);
});
test("mergeSliceAnalyses re-renders findings from every slice", () => {
    const first = [
        "### Analysis: first slice has a bug.",
        "",
        "#### Findings / Actions",
        "- **[🔴 Critical `a.ts:1`]: nil deref.",
        "",
        "#### Solution",
        "```go",
        "if u == nil {",
        "  return",
        "}",
        "```",
        "",
    ].join("\n");
    const second = [
        "### Analysis: second slice has a warning.",
        "",
        "#### Findings / Actions",
        "- **[🟡 Warning `b.ts:2`]: unchecked error.",
        "",
        "#### Solution",
        "```go",
        "_ = err",
        "```",
        "",
    ].join("\n");
    const merged = mergeSliceAnalyses([first, second]);
    assert.equal(merged.allLgtm, false);
    assert.equal(merged.sliceCount, 2);
    assert.match(merged.text, /Review completed across 2 slices\./);
    assert.match(merged.text, /first slice has a bug\. second slice has a warning\./);
    const findings = parseFindings(merged.text);
    assert.equal(findings.length, 2);
    assert.equal(findings[0]?.severity, "critical");
    assert.equal(findings[0]?.location, "a.ts:1");
    assert.equal(findings[1]?.severity, "warning");
    assert.match(merged.text, /if u == nil \{/);
    assert.match(merged.text, /_ = err/);
    assert.deepEqual(validateAnalysis(merged.text, "review"), []);
});
test("mergeSliceAnalyses handles mixed LGTM and findings slices", () => {
    const withFinding = [
        "### Analysis: one problem.",
        "",
        "#### Findings / Actions",
        "- **[🔴 Critical `x.go:3`]: race.",
        "",
        "#### Solution",
        "add mutex",
        "",
    ].join("\n");
    const merged = mergeSliceAnalyses(["LGTM: no critical issues found.", withFinding]);
    assert.equal(merged.allLgtm, false);
    assert.equal(parseFindings(merged.text).length, 1);
});
test("mergeSliceAnalyses renders Russian sections for lang=ru", () => {
    const response = [
        "### Анализ: проблема найдена.",
        "",
        "#### Замечания / Действия",
        "- **[🔴 Critical `a.go:1`]: ошибка.",
        "",
        "#### Решение",
        "исправить",
        "",
    ].join("\n");
    const merged = mergeSliceAnalyses([response], "ru");
    assert.match(merged.text, /### Анализ: Ревью выполнено по 1 частям\. проблема найдена\./);
    assert.match(merged.text, /#### Замечания \/ Действия/);
    assert.match(merged.text, /#### Решение/);
});
test("mergeSliceAnalyses handles findings-less slices", () => {
    const response = [
        "### Analysis: nothing to fix but not LGTM.",
        "",
        "#### Findings / Actions",
        "",
        "#### Solution",
        "none",
        "",
    ].join("\n");
    const merged = mergeSliceAnalyses([response]);
    assert.match(merged.text, /- No findings\./);
    assert.match(merged.text, /#### Solution\nnone/);
    assert.deepEqual(validateAnalysis(merged.text, "review"), []);
});
test("solutionSection extracts only the solution body", () => {
    const text = [
        "### Analysis: summary",
        "",
        "#### Findings / Actions",
        "- **[🟡 Warning `a.ts:1`]: warn",
        "",
        "#### Solution",
        "line one",
        "line two",
        "",
        "### Next heading",
        "after",
    ].join("\n");
    assert.equal(solutionSection(text), "line one\nline two");
    assert.equal(solutionSection("no sections here"), "");
});
test("executeRecipeDetailed splits oversized diffs across multiple API calls", async () => {
    const sliceResponse = [
        "### Analysis: slice reviewed.",
        "",
        "#### Findings / Actions",
        "- **[🔴 Critical `big.ts:1`]: bug in slice",
        "",
        "#### Solution",
        "```ts",
        "export const fixed = true;",
        "```",
        "",
    ].join("\n");
    let requests = 0;
    const server = createServer((request, response) => {
        requests += 1;
        request.resume();
        request.on("end", () => {
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ choices: [{ message: { content: sliceResponse } }] }));
        });
    });
    const url = await new Promise((resolvePromise) => {
        server.listen(0, "127.0.0.1", () => {
            resolvePromise(`http://127.0.0.1:${server.address().port}/v1`);
        });
    });
    try {
        const bigBlock = (name) => `diff --git a/${name} b/${name}\nindex 111..222 100644\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n+${"a".repeat(160_000)}\n`;
        const diff = bigBlock("one.ts") + bigBlock("two.ts");
        const ctx = {
            cwd: process.cwd(),
            config: {
                ...DEFAULT_CONFIG,
                engine: "openai",
                baseUrl: url,
                model: "test-model",
                timeoutSeconds: 30,
                repoContext: false,
            },
            flags: { cwd: process.cwd(), json: false, dryRun: false, verbose: false, strict: false, github: false },
        };
        const execution = await executeRecipeDetailed({
            recipe: "review",
            projectType: "TypeScript",
            additionalContext: "",
            diff,
            secretFindings: [],
            changedFiles: ["one.ts", "two.ts"],
        }, ctx, { capture: true });
        assert.equal(requests, 2);
        assert.equal(execution.meta?.slices, 2);
        assert.equal(parseFindings(execution.analysis ?? "").length, 2);
        assert.match(execution.analysis ?? "", /Review completed across 2 slices\./);
        assert.deepEqual(validateAnalysis(execution.analysis ?? "", "review"), []);
    }
    finally {
        server.close();
    }
});
test("executeRecipeDetailed runs slices concurrently and keeps their order", async () => {
    let requests = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const server = createServer((request, response) => {
        requests += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        let raw = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
            raw += chunk;
        });
        request.on("end", () => {
            const marker = [
                ["one", "a"],
                ["two", "b"],
                ["three", "c"],
            ].find(([, pad]) => raw.includes(pad.repeat(50)))?.[0] ?? "one";
            const content = [
                `### Analysis: ${marker} reviewed.`,
                "",
                "#### Findings / Actions",
                `- **[🔴 Critical \`${marker}.ts:1\`]: bug in ${marker}`,
                "",
                "#### Solution",
                "none",
                "",
            ].join("\n");
            setTimeout(() => {
                inFlight -= 1;
                response.setHeader("content-type", "application/json");
                response.end(JSON.stringify({ choices: [{ message: { content } }] }));
            }, 120);
        });
    });
    const url = await new Promise((resolvePromise) => {
        server.listen(0, "127.0.0.1", () => {
            resolvePromise(`http://127.0.0.1:${server.address().port}/v1`);
        });
    });
    try {
        const bigBlock = (name, pad) => `diff --git a/${name}.ts b/${name}.ts\nindex 111..222 100644\n--- a/${name}.ts\n+++ b/${name}.ts\n@@ -1 +1 @@\n+${pad.repeat(160_000)}\n`;
        const diff = bigBlock("one", "a") + bigBlock("two", "b") + bigBlock("three", "c");
        const ctx = {
            cwd: process.cwd(),
            config: {
                ...DEFAULT_CONFIG,
                engine: "openai",
                baseUrl: url,
                model: "slice-parallel-model",
                timeoutSeconds: 30,
                repoContext: false,
            },
            flags: { cwd: process.cwd(), json: false, dryRun: false, verbose: false, strict: false, github: false },
        };
        const execution = await executeRecipeDetailed({
            recipe: "review",
            projectType: "TypeScript",
            additionalContext: "",
            diff,
            secretFindings: [],
            changedFiles: ["one.ts", "two.ts", "three.ts"],
        }, ctx, { capture: true });
        assert.equal(requests, 3);
        assert.equal(execution.meta?.slices, 3);
        assert.ok(maxInFlight >= 2, "slices should overlap");
        assert.ok(maxInFlight <= 3, "concurrency must stay bounded");
        const locations = parseFindings(execution.analysis ?? "").map((finding) => finding.location);
        assert.deepEqual(locations, ["one.ts:1", "two.ts:1", "three.ts:1"]);
    }
    finally {
        server.close();
    }
});
//# sourceMappingURL=slicing.test.js.map