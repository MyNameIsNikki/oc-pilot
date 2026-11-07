import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderButterfly, runButterfly } from "./butterfly.js";
function makeRepo(files) {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-butterfly-test-"));
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(join(dir, path, ".."), { recursive: true });
        writeFileSync(join(dir, path), content, "utf8");
    }
    return dir;
}
const unhandledFetch = [
    'const response = await fetch("http://butterfly.test");',
    'if (!response.ok) throw new Error("http " + response.status);',
    'console.log("ok");',
    "",
].join("\n");
const resilientFetch = [
    "try {",
    '  const response = await fetch("http://butterfly.test");',
    '  if (!response.ok) throw new Error("http " + response.status);',
    '  console.log("ok");',
    "} catch (error) {",
    '  console.log("caught " + error.message);',
    "}",
    "",
].join("\n");
test("an unhandled HTTP 500 fails the command and is counted", async () => {
    const dir = makeRepo({ "src/app.mjs": unhandledFetch });
    try {
        const report = await runButterfly(dir, { command: "node src/app.mjs", failRate: 1, timeoutMs: 10_000 });
        assert.equal(report.status, "fail", report.summary);
        assert.equal(report.faults.http500, 1);
        assert.equal(report.totalFaults, 1);
        assert.match(report.output, /Error: http 500/);
        assert.match(renderButterfly(report), /Butterfly: fail/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("a resilient handler passes while faults are still injected", async () => {
    const dir = makeRepo({ "src/app.mjs": resilientFetch });
    try {
        const report = await runButterfly(dir, { command: "node src/app.mjs", failRate: 1, timeoutMs: 10_000 });
        assert.equal(report.status, "pass", report.summary);
        assert.equal(report.faults.http500, 1);
        assert.match(report.output, /caught http 500/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("filesystem faults are injected for scoped code", async () => {
    const dir = makeRepo({
        "data.txt": "hello\n",
        "src/app.mjs": 'import { readFileSync } from "node:fs";\nconsole.log(readFileSync("data.txt", "utf8"));\n',
    });
    try {
        const report = await runButterfly(dir, {
            command: "node src/app.mjs",
            failRate: 0,
            latencyRate: 0,
            brokenJsonRate: 0,
            fsFailRate: 1,
            timeoutMs: 10_000,
        });
        assert.equal(report.status, "fail", report.summary);
        assert.equal(report.faults.fsError, 1);
        assert.match(report.output, /ButterflyError: filesystem fault injected/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("code outside the scope is not injected", async () => {
    const dir = makeRepo({
        "data.txt": "hello\n",
        "outside.mjs": 'import { readFileSync } from "node:fs";\nconsole.log(readFileSync("data.txt", "utf8"));\n',
    });
    try {
        const report = await runButterfly(dir, {
            command: "node outside.mjs",
            failRate: 0,
            latencyRate: 0,
            brokenJsonRate: 0,
            fsFailRate: 1,
            timeoutMs: 10_000,
        });
        assert.equal(report.status, "pass", report.summary);
        assert.equal(report.totalFaults, 0);
        assert.match(report.output, /hello/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("broken JSON is injected and reported", async () => {
    const dir = makeRepo({
        "src/app.mjs": [
            'const response = await fetch("http://butterfly.test");',
            "const value = await response.json();",
            "console.log(value);",
            "",
        ].join("\n"),
    });
    try {
        const report = await runButterfly(dir, {
            command: "node src/app.mjs",
            failRate: 0,
            latencyRate: 0,
            brokenJsonRate: 1,
            fsFailRate: 0,
            timeoutMs: 10_000,
        });
        assert.equal(report.status, "fail", report.summary);
        assert.equal(report.faults.brokenJson, 1);
        assert.match(report.output, /JSON/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("a clean command passes without faults", async () => {
    const dir = makeRepo({ "src/clean.mjs": 'console.log("clean");\n' });
    try {
        const report = await runButterfly(dir, {
            command: "node src/clean.mjs",
            failRate: 0,
            latencyRate: 0,
            brokenJsonRate: 0,
            fsFailRate: 0,
            timeoutMs: 10_000,
        });
        assert.equal(report.status, "pass", report.summary);
        assert.equal(report.totalFaults, 0);
        assert.match(report.output, /clean/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=butterfly.test.js.map