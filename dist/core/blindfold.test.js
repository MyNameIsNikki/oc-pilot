import assert from "node:assert/strict";
import test from "node:test";
import { buildBlindfoldPrompt, judgeBlindfold, obfuscateCode, parseBlindfoldVerdict, parseMinConfidence, renderBlindfold, } from "./blindfold.js";
test("obfuscateCode renames identifiers and preserves literals and properties", () => {
    const code = [
        "// calculateDiscount keeps its comment",
        "const calculateDiscount = (user) => user.total * 0.9;",
        'const label = "calculateDiscount";',
        "console.log(calculateDiscount({ total: 100 }).toFixed(2), label);",
    ].join("\n");
    const result = obfuscateCode(code);
    assert.ok(result.mapping.some((entry) => entry.original === "calculateDiscount"));
    assert.ok(result.mapping.some((entry) => entry.original === "user"));
    assert.ok(!result.code.includes("const calculateDiscount"));
    assert.ok(!result.code.includes("(user)"));
    assert.ok(result.code.includes("// calculateDiscount keeps its comment"));
    assert.ok(result.code.includes('"calculateDiscount"'));
    assert.ok(result.code.includes(".total"));
    assert.ok(result.code.includes(".toFixed"));
    assert.ok(result.code.includes("console.log"));
});
test("obfuscateCode keeps object keys and is deterministic", () => {
    const code = [
        "const payload = { token: secret, nested: { value: 1 } };",
        "return payload.nested.value;",
    ].join("\n");
    const first = obfuscateCode(code);
    const second = obfuscateCode(code);
    assert.deepEqual(first, second);
    assert.ok(first.code.includes("token:"));
    assert.ok(first.code.includes("nested:"));
    assert.ok(first.code.includes("value:"));
    assert.ok(first.code.includes(".nested.value"));
    assert.ok(!first.code.includes("payload"));
    assert.ok(!first.code.includes("secret"));
});
test("parseBlindfoldVerdict accepts fenced JSON and rejects broken output", () => {
    const verdict = parseBlindfoldVerdict('```json\n{"understood":true,"vulnerability":false,"confidence":0.82,"explanation":"ok"}\n```');
    assert.deepEqual(verdict, { understood: true, vulnerability: false, confidence: 0.82, explanation: "ok" });
    assert.equal(parseBlindfoldVerdict("not json"), undefined);
    assert.equal(parseBlindfoldVerdict('{"understood":true}'), undefined);
});
test("judgeBlindfold rejects unknown, vulnerable and low-confidence code", () => {
    assert.equal(judgeBlindfold(undefined, 0.6).status, "error");
    assert.equal(judgeBlindfold({ understood: false, vulnerability: false, confidence: 0.9, explanation: "opaque" }, 0.6).status, "fail");
    assert.equal(judgeBlindfold({ understood: true, vulnerability: true, confidence: 0.9, explanation: "division by zero" }, 0.6).status, "fail");
    assert.equal(judgeBlindfold({ understood: true, vulnerability: false, confidence: 0.3, explanation: "unsure" }, 0.6).status, "fail");
    const pass = judgeBlindfold({ understood: true, vulnerability: false, confidence: 0.8, explanation: "safe" }, 0.6);
    assert.equal(pass.status, "pass");
    assert.match(pass.summary, /уязвимостей не найдено/);
});
test("buildBlindfoldPrompt asks for strict JSON and renderBlindfold shows the verdict", () => {
    const prompt = buildBlindfoldPrompt("const fn_A = (var_A) => var_A + 1;", "test context");
    assert.match(prompt, /strict JSON/);
    assert.match(prompt, /"understood":true/);
    assert.match(prompt, /test context/);
    assert.match(prompt, /fn_A/);
    const report = {
        source: "file:src/app.ts",
        file: "src/app.ts",
        status: "pass",
        summary: "Код понятен без имён, уязвимостей не найдено.",
        verdict: { understood: true, vulnerability: false, confidence: 0.8, explanation: "safe" },
        mapping: [{ original: "calculateDiscount", replacement: "var_A" }],
    };
    const text = renderBlindfold(report);
    assert.match(text, /Blindfold: pass/);
    assert.match(text, /Identifiers hidden: 1/);
    assert.match(text, /confidence=0.80/);
    assert.match(text, /уязвимостей не найдено/);
});
test("parseMinConfidence validates the range", () => {
    assert.equal(parseMinConfidence(undefined), 0.6);
    assert.equal(parseMinConfidence("0.8"), 0.8);
    assert.throws(() => parseMinConfidence("2"), /Некорректный порог/);
});
//# sourceMappingURL=blindfold.test.js.map