import assert from "node:assert/strict";
import test from "node:test";
import { buildFlakyReport, classifyRuns, parseTestOutput, renderFlaky, stripAnsi, } from "./flaky.js";
function map(entries) {
    return new Map(Object.entries(entries));
}
test("parseTestOutput reads the node spec reporter", () => {
    const output = ["  ✔ adds numbers (12ms)", "  ✖ subtracts (3.5ms)", "  ✔ keeps state (1.2s)"].join("\n");
    const results = parseTestOutput(output);
    assert.equal(results.get("adds numbers"), "pass");
    assert.equal(results.get("subtracts"), "fail");
    assert.equal(results.get("keeps state"), "pass");
});
test("parseTestOutput reads TAP", () => {
    const results = parseTestOutput(["ok 1 - alpha", "not ok 2 - beta", "ok 3 - gamma # SKIP"].join("\n"));
    assert.equal(results.get("alpha"), "pass");
    assert.equal(results.get("beta"), "fail");
});
test("parseTestOutput reads go and pytest markers", () => {
    const go = ["--- PASS: TestWallet", "--- FAIL: TestTransfer (0.01s)"].join("\n");
    assert.equal(parseTestOutput(go).get("TestWallet"), "pass");
    assert.equal(parseTestOutput(go).get("TestTransfer"), "fail");
    const pytest = ["PASSED tests/test_wallet.py::test_balance", "FAILED tests/test_wallet.py::test_send"].join("\n");
    assert.equal(parseTestOutput(pytest).get("tests/test_wallet.py::test_balance"), "pass");
    assert.equal(parseTestOutput(pytest).get("tests/test_wallet.py::test_send"), "fail");
});
test("parseTestOutput reads jest and vitest markers", () => {
    const output = ["  ✓ renders the form", "  ✕ submits the form", "  × handles errors"].join("\n");
    const results = parseTestOutput(output);
    assert.equal(results.get("renders the form"), "pass");
    assert.equal(results.get("submits the form"), "fail");
    assert.equal(results.get("handles errors"), "fail");
});
test("parseTestOutput strips ANSI colour codes", () => {
    const output = "\u001B[32m✔\u001B[39m coloured (2ms)";
    assert.equal(stripAnsi(output), "✔ coloured (2ms)");
    assert.equal(parseTestOutput(output).get("coloured"), "pass");
});
test("parseTestOutput returns nothing for unrecognised output", () => {
    assert.equal(parseTestOutput("all good, trust me\n").size, 0);
});
test("classifyRuns separates flaky, failing and passing tests", () => {
    const outcomes = classifyRuns([
        map({ alpha: "pass", beta: "fail", gamma: "pass" }),
        map({ alpha: "fail", beta: "fail", gamma: "pass" }),
    ]);
    assert.deepEqual(outcomes.map((outcome) => [outcome.name, outcome.status, outcome.passes, outcome.failures]), [
        ["alpha", "flaky", 1, 1],
        ["beta", "failing", 0, 2],
        ["gamma", "passing", 2, 0],
    ]);
});
test("buildFlakyReport tracks completion and parsed output", () => {
    const runs = [
        { exitCode: 0, timedOut: false, durationMs: 10, output: "✔ alpha" },
        { exitCode: null, timedOut: true, durationMs: 5000, output: "✖ alpha" },
    ];
    const report = buildFlakyReport("npm test", runs);
    assert.equal(report.runs, 2);
    assert.equal(report.completed, 1);
    assert.equal(report.parsed, true);
    assert.equal(report.flaky.length, 1);
    assert.equal(report.flaky[0]?.name, "alpha");
    const unparsed = buildFlakyReport("npm test", [{ exitCode: 0, timedOut: false, durationMs: 1, output: "ok" }]);
    assert.equal(unparsed.parsed, false);
    assert.deepEqual(unparsed.tests, []);
});
test("renderFlaky prints the flaky and failing lists", () => {
    const report = buildFlakyReport("npm test", [
        { exitCode: 0, timedOut: false, durationMs: 10, output: "✔ alpha\n✖ beta" },
        { exitCode: 1, timedOut: false, durationMs: 10, output: "✖ alpha\n✖ beta" },
    ]);
    const text = renderFlaky(report);
    assert.match(text, /Команда: npm test/);
    assert.match(text, /Прогонов: 2 \(завершено 2\)/);
    assert.match(text, /Нестабильные \(1\):/);
    assert.match(text, /alpha — упал в 1 из 2 прогонов/);
    assert.match(text, /Всегда падают \(1\):/);
    const unparsed = renderFlaky(buildFlakyReport("npm test", [{ exitCode: 0, timedOut: false, durationMs: 1, output: "ok" }]));
    assert.match(unparsed, /Не удалось распознать/);
});
//# sourceMappingURL=flaky.test.js.map