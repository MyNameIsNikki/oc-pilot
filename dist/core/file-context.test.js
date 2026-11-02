import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildFileContext } from "./file-context.js";
const OPENAI_KEY = ["sk-proj-", "d".repeat(40)].join("");
test("buildFileContext includes full changed files", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-files-"));
    try {
        writeFileSync(join(dir, "service.go"), "package wallet\n\nfunc Pay() {}\n");
        const context = buildFileContext(dir, ["service.go"]);
        assert.deepEqual(context.files, ["service.go"]);
        assert.ok(context.text.includes("--- FILE: service.go ---"));
        assert.ok(context.text.includes("func Pay() {}"));
        assert.deepEqual(context.omitted, []);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("buildFileContext redacts secrets and reports findings", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-files-"));
    try {
        writeFileSync(join(dir, "config.ts"), `const key = "${OPENAI_KEY}";\n`);
        const context = buildFileContext(dir, ["config.ts"]);
        assert.equal(context.findings.length, 1);
        assert.ok(!context.text.includes(OPENAI_KEY));
        assert.ok(context.text.includes("[REDACTED:OpenAI API key]"));
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("buildFileContext refuses paths outside the project", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-files-"));
    try {
        writeFileSync(join(dir, "inside.ts"), "export {};\n");
        const context = buildFileContext(dir, ["../outside.ts", join(dir, "inside.ts")]);
        assert.deepEqual(context.files, []);
        assert.equal(context.omitted.length, 2);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("buildFileContext omits missing files", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-files-"));
    try {
        const context = buildFileContext(dir, ["missing.go"]);
        assert.deepEqual(context.files, []);
        assert.deepEqual(context.omitted, ["missing.go"]);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=file-context.test.js.map