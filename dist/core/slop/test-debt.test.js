import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTestIndex, describeTarget, formatTestTargets, hasTestFile, rankTestTargets, syntheticTargetDiff, } from "./test-debt.js";
test("buildTestIndex maps every test naming convention to its module stem", () => {
    const index = buildTestIndex([
        "src/foo.test.ts",
        "lib/wallet_test.go",
        "app/test_parser.py",
        "src/FooTest.java",
        "src/view.spec.tsx",
        "src/bar.ts",
    ]);
    assert.deepEqual([...index].sort(), ["app/parser", "lib/wallet", "src/foo", "src/view"]);
    assert.equal(hasTestFile("src/foo.ts", index), true);
    assert.equal(hasTestFile("src/view.tsx", index), true);
    assert.equal(hasTestFile("lib/wallet.go", index), true);
    assert.equal(hasTestFile("app/parser.py", index), true);
    assert.equal(hasTestFile("src/bar.ts", index), false);
});
test("hasTestFile matches a test that sits at the repository root", () => {
    const index = buildTestIndex(["foo.test.ts"]);
    assert.equal(hasTestFile("src/foo.ts", index), true);
});
test("rankTestTargets prefers churn and duplicate signals over file size", () => {
    const targets = rankTestTargets([
        { path: "src/wallet.ts", text: "line\n".repeat(10) },
        { path: "src/big.ts", text: "line\n".repeat(400) },
        { path: "src/small.ts", text: "line\n".repeat(20) },
    ], {
        churn: [{ file: "src/wallet.ts", commits: 7, days: 30, testCommits: 0 }],
        duplicates: [
            {
                first: { file: "src/wallet.ts", line: 1 },
                second: { file: "src/big.ts", line: 1 },
                tokens: 400,
            },
        ],
        todos: [{ file: "src/wallet.ts", line: 2, text: "TODO: audit" }],
    }, new Set());
    assert.deepEqual(targets.map((target) => target.file), ["src/wallet.ts", "src/big.ts", "src/small.ts"]);
    const [wallet, big, small] = targets;
    assert.equal(wallet.score, 14.8);
    assert.equal(wallet.lines, 10);
    assert.deepEqual(wallet.reasons, [
        "churn: 7 commits over 30 days, test files changed 0 times",
        "duplicates: 1 blocks (~400 tokens)",
        "todos: 1",
    ]);
    assert.equal(big.score, 3);
    assert.equal(small.score, 0.1);
    assert.match(small.reasons[0], /no entropy signal yet: untested file, 20 lines/);
});
test("rankTestTargets skips tested, generated, empty and oversized files", () => {
    const targets = rankTestTargets([
        { path: "src/covered.ts", text: "code\n" },
        { path: "src/thing.test.ts", text: "test\n" },
        { path: "dist/bundle.js", text: "built\n" },
        { path: "src/empty.ts", text: "  \n" },
        { path: "src/huge.ts", text: "x".repeat(25_000) },
        { path: "src/kept.ts", text: "code\n" },
    ], { churn: [], duplicates: [], todos: [] }, buildTestIndex(["src/covered.test.ts"]));
    assert.deepEqual(targets.map((target) => target.file), ["src/kept.ts"]);
});
test("rankTestTargets honours the limit and sorts ties by lines then path", () => {
    const targets = rankTestTargets([
        { path: "src/b.ts", text: "line\n".repeat(10) },
        { path: "src/a.ts", text: "line\n".repeat(10) },
        { path: "src/c.ts", text: "line\n".repeat(50) },
    ], { churn: [], duplicates: [], todos: [] }, new Set(), { limit: 2 });
    assert.deepEqual(targets.map((target) => target.file), ["src/c.ts", "src/a.ts"]);
});
test("syntheticTargetDiff renders each target as a new file block", () => {
    const diff = syntheticTargetDiff([
        { path: "src/a.ts", text: "const a = 1;\n\n" },
        { path: "src/b.ts", text: "one\ntwo" },
    ]);
    assert.equal(diff, [
        "diff --git a/src/a.ts b/src/a.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/a.ts",
        "@@ -0,0 +1,1 @@",
        "+const a = 1;",
        "diff --git a/src/b.ts b/src/b.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/b.ts",
        "@@ -0,0 +1,2 @@",
        "+one",
        "+two",
        "",
    ].join("\n"));
    assert.equal(syntheticTargetDiff([{ path: "src/blank.ts", text: "\n\n" }]), "");
});
test("formatTestTargets lists the reasons of every target", () => {
    const targets = [
        { file: "src/wallet.ts", lines: 10, score: 11, reasons: ["churn: 7 commits over 30 days, test files changed 0 times"] },
        { file: "src/api.ts", lines: 40, score: 2, reasons: ["no entropy signal yet: untested file, 40 lines"] },
    ];
    assert.equal(formatTestTargets(targets), [
        "TEST_DEBT_TARGETS: untested files chosen by the slop scan (churn, duplicates, TODOs). Write tests for these files:",
        "- src/wallet.ts  churn: 7 commits over 30 days, test files changed 0 times",
        "- src/api.ts  no entropy signal yet: untested file, 40 lines",
    ].join("\n"));
    assert.equal(formatTestTargets([]), "");
});
test("describeTarget explains the strongest signal in Russian", () => {
    const base = { file: "x.ts", lines: 12, score: 1, reasons: [] };
    assert.equal(describeTarget({ ...base, commits: 7, testCommits: 0 }), "7 коммитов / 0 с тестами");
    assert.equal(describeTarget({ ...base, duplicateBlocks: 3 }), "3 дублей");
    assert.equal(describeTarget({ ...base, todos: 2 }), "2 TODO");
    assert.equal(describeTarget(base), "12 строк без тестов");
});
//# sourceMappingURL=test-debt.test.js.map