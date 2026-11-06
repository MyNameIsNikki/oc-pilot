import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeEnvSync, extractEnvReferences, listEnvFiles } from "./env-sync.js";
const DIFF = [
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,2 +1,8 @@",
    " const a = 1;",
    "+const key = process.env.NEW_SERVICE_KEY;",
    '+const quoted = process.env["QUOTED_KEY"];',
    "+const vite = import.meta.env.VITE_API_URL;",
    '+const deno = Deno.env.get("DENO_TOKEN");',
    "+const bun = Bun.env.BUN_FLAG;",
    "+const ignored = process.env.NODE_ENV;",
    " const b = 2;",
    "",
].join("\n");
test("extractEnvReferences reads every supported env syntax", () => {
    const references = extractEnvReferences(DIFF);
    assert.deepEqual(references.map((reference) => reference.name), ["NEW_SERVICE_KEY", "QUOTED_KEY", "VITE_API_URL", "DENO_TOKEN", "BUN_FLAG"]);
    assert.deepEqual(references.map((reference) => reference.line), [2, 3, 4, 5, 6]);
    assert.deepEqual(references.map((reference) => reference.source), ["process.env", "process.env", "import.meta.env", "Deno.env", "Bun.env"]);
    assert.ok(references.every((reference) => reference.file === "src/app.ts"));
    assert.ok(!references.some((reference) => reference.name === "NODE_ENV"));
});
test("analyzeEnvSync warns about defined but undocumented variables", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-env-sync-"));
    try {
        writeFileSync(join(dir, ".env"), "NEW_SERVICE_KEY=1\nQUOTED_KEY=2\nVITE_API_URL=https://example.com\nDENO_TOKEN=3\nBUN_FLAG=1\n", "utf8");
        writeFileSync(join(dir, ".env.example"), "NEW_SERVICE_KEY=\n", "utf8");
        const report = analyzeEnvSync(dir, DIFF);
        assert.equal(report.status, "warn");
        assert.deepEqual(report.envFiles, [".env", ".env.example"]);
        assert.deepEqual(report.exampleFiles, [".env.example"]);
        assert.deepEqual(report.missing, []);
        assert.deepEqual(report.undocumented, ["BUN_FLAG", "DENO_TOKEN", "QUOTED_KEY", "VITE_API_URL"]);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("analyzeEnvSync fails on a referenced variable that is not defined", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-env-sync-"));
    try {
        writeFileSync(join(dir, ".env"), "NEW_SERVICE_KEY=1\nQUOTED_KEY=2\nVITE_API_URL=x\n", "utf8");
        writeFileSync(join(dir, ".env.example"), "NEW_SERVICE_KEY=\nQUOTED_KEY=\nVITE_API_URL=\nDENO_TOKEN=\n", "utf8");
        const report = analyzeEnvSync(dir, DIFF);
        assert.equal(report.status, "fail");
        assert.deepEqual(report.missing, ["BUN_FLAG"]);
        assert.deepEqual(report.undocumented, []);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("analyzeEnvSync passes when every variable is defined and documented", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-env-sync-"));
    try {
        writeFileSync(join(dir, ".env"), "NEW_SERVICE_KEY=1\nQUOTED_KEY=2\nVITE_API_URL=x\nDENO_TOKEN=y\nBUN_FLAG=1\n", "utf8");
        writeFileSync(join(dir, ".env.example"), "NEW_SERVICE_KEY=\nQUOTED_KEY=\nVITE_API_URL=\nDENO_TOKEN=\nBUN_FLAG=\n", "utf8");
        const report = analyzeEnvSync(dir, DIFF);
        assert.equal(report.status, "pass");
        assert.deepEqual(report.missing, []);
        assert.deepEqual(report.undocumented, []);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("listEnvFiles parses export lines and detects example files", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-env-sync-"));
    try {
        writeFileSync(join(dir, ".env.local"), "export SECRET_TOKEN=abc\n", "utf8");
        writeFileSync(join(dir, ".env.example"), "SECRET_TOKEN=\n", "utf8");
        writeFileSync(join(dir, "README.md"), "# demo\n", "utf8");
        assert.deepEqual(listEnvFiles(dir), [".env.example", ".env.local"]);
        const diff = [
            "diff --git a/src/auth.ts b/src/auth.ts",
            "--- a/src/auth.ts",
            "+++ b/src/auth.ts",
            "@@ -1,1 +1,2 @@",
            " const a = 1;",
            "+const token = process.env.SECRET_TOKEN;",
            "",
        ].join("\n");
        const report = analyzeEnvSync(dir, diff);
        assert.equal(report.status, "pass");
        assert.deepEqual(report.defined, ["SECRET_TOKEN"]);
        assert.deepEqual(report.documented, ["SECRET_TOKEN"]);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=env-sync.test.js.map