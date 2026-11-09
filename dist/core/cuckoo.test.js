import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderCuckoo, runCuckoo } from "./cuckoo.js";
function makeDir(files) {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cuckoo-"));
    for (const [path, content] of Object.entries(files)) {
        writeFileSync(join(dir, path), content, "utf8");
    }
    return dir;
}
test("runCuckoo reports a clean file with no capabilities", () => {
    const dir = makeDir({ "safe.mjs": 'console.log("hello");\n' });
    try {
        const report = runCuckoo(dir, "safe.mjs");
        assert.equal(report.status, "clean", report.summary);
        assert.deepEqual(report.capabilities, []);
        assert.deepEqual(report.output, ["hello"]);
        assert.match(report.summary, /\[CAPABILITY CLEAN\]/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("runCuckoo records fs, net and env capabilities", () => {
    const dir = makeDir({
        "fs.mjs": 'const fs = require("fs"); fs.readFileSync("/etc/passwd");\n',
        "net.mjs": 'fetch("https://example.com/data");\n',
        "env.mjs": "process.env.SECRET;\n",
    });
    try {
        const fsReport = runCuckoo(dir, "fs.mjs");
        assert.equal(fsReport.status, "capabilities");
        assert.ok(fsReport.capabilities.some((item) => item.kind === "fs"));
        assert.match(fsReport.summary, /\[CAPABILITY DENIED\]/);
        const netReport = runCuckoo(dir, "net.mjs");
        assert.ok(netReport.capabilities.some((item) => item.kind === "net"));
        const envReport = runCuckoo(dir, "env.mjs");
        assert.ok(envReport.capabilities.some((item) => item.kind === "env"));
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("runCuckoo blocks process.exit and static imports", () => {
    const dir = makeDir({
        "exit.mjs": "process.exit(1);\n",
        "import.mjs": 'import fs from "fs";\nconsole.log(fs);\n',
    });
    try {
        const exitReport = runCuckoo(dir, "exit.mjs");
        assert.equal(exitReport.status, "blocked");
        assert.ok(exitReport.capabilities.some((item) => item.kind === "exit"));
        const importReport = runCuckoo(dir, "import.mjs");
        assert.equal(importReport.status, "blocked");
        assert.ok(importReport.capabilities.some((item) => item.kind === "import"));
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("runCuckoo reports timeouts and ordinary errors", () => {
    const dir = makeDir({
        "loop.mjs": "while (true) {}\n",
        "throw.mjs": 'throw new Error("boom");\n',
    });
    try {
        const timeout = runCuckoo(dir, "loop.mjs", { timeoutMs: 200 });
        assert.equal(timeout.status, "timeout", timeout.summary);
        assert.match(timeout.summary, /\[CUCKOO TIMEOUT\]/);
        const error = runCuckoo(dir, "throw.mjs");
        assert.equal(error.status, "error");
        assert.match(error.summary, /\[CUCKOO ERROR\]/);
        assert.match(error.error ?? "", /boom/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("runCuckoo rejects a missing file and renderCuckoo shows capabilities", () => {
    const dir = makeDir({
        "fs.mjs": 'const fs = require("fs"); fs.writeFileSync("/tmp/x", "y");\n',
    });
    try {
        assert.throws(() => runCuckoo(dir, "missing.mjs"), /Файл не найден/);
        const report = runCuckoo(dir, "fs.mjs");
        const text = renderCuckoo(report);
        assert.match(text, /Cuckoo: capabilities/);
        assert.match(text, /fs: write:/);
        assert.match(text, /CAPABILITY DENIED/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=cuckoo.test.js.map