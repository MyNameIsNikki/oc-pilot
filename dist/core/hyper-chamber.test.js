import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderHyperChamber, runHyperChamber } from "./hyper-chamber.js";
function makeRepo(files) {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-hyper-chamber-test-"));
    for (const [path, content] of Object.entries(files))
        writeFileSync(join(dir, path), content, "utf8");
    return dir;
}
test("stable exported function survives the simulated year", () => {
    const dir = makeRepo({
        "stable.mjs": [
            "export function run() {",
            "  const items = [];",
            "  for (let i = 0; i < 20; i += 1) items.push({ i });",
            "  return items.length;",
            "}",
            "",
        ].join("\n"),
    });
    try {
        const result = runHyperChamber(dir, "stable.mjs", { days: 365, budgetMs: 300, memoryMb: 256 });
        assert.equal(result.status, "ok", result.summary);
        assert.ok(result.iterations > 0, "no iterations");
        assert.match(renderHyperChamber(result), /Hyper chamber: ok/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("a retained cache is reported as a memory leak with a crash day", () => {
    const dir = makeRepo({
        "leak.mjs": [
            "const cache = [];",
            "export function run() {",
            "  cache.push({ i: cache.length, payload: 'x'.repeat(1024) });",
            "  return cache.length;",
            "}",
            "",
        ].join("\n"),
    });
    try {
        const result = runHyperChamber(dir, "leak.mjs", { days: 365, budgetMs: 800, memoryMb: 256 });
        assert.equal(result.status, "leak", result.summary);
        assert.match(result.summary, /\[MEMORY LEAK DETECTED\]: AI code survives Day 1, but crashes on Day \d+ of simulated uptime\./);
        assert.ok(result.crashDay >= 1 && result.crashDay <= 365, `crashDay=${String(result.crashDay)}`);
        assert.match(renderHyperChamber(result), /\[MEMORY LEAK DETECTED\]/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("static imports are blocked", () => {
    const dir = makeRepo({
        "blocked.mjs": 'import fs from "node:fs";\nexport function run() { return fs; }\n',
    });
    try {
        const result = runHyperChamber(dir, "blocked.mjs", { budgetMs: 200 });
        assert.equal(result.status, "error", result.summary);
        assert.match(result.error ?? "", /import blocked/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("an infinite loop stops as a timeout", () => {
    const dir = makeRepo({ "loop.mjs": "export function run() { while (true) {} }\n" });
    try {
        const result = runHyperChamber(dir, "loop.mjs", { budgetMs: 500 });
        assert.equal(result.status, "timeout", result.summary);
        assert.match(result.summary, /таймауту/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("a module without a runnable export is rejected", () => {
    const dir = makeRepo({ "empty.mjs": "export const value = 1;\n" });
    try {
        const result = runHyperChamber(dir, "empty.mjs", { budgetMs: 200 });
        assert.equal(result.status, "error", result.summary);
        assert.match(result.error ?? "", /export a function/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("a plain script is wrapped and executed repeatedly", () => {
    const dir = makeRepo({
        "plain.js": "const items = [];\nfor (let i = 0; i < 10; i += 1) items.push(i);\nconsole.log(items.length);\n",
    });
    try {
        const result = runHyperChamber(dir, "plain.js", { budgetMs: 1_000, memoryMb: 256 });
        assert.equal(result.status, "ok", result.summary);
        assert.ok(result.iterations > 0, "no iterations");
        assert.ok(result.output.includes("10"), `output=${result.output.join("|")}`);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=hyper-chamber.test.js.map