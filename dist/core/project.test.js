import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectProjectType, detectTestCommand, languageFromPath } from "./project.js";
function tempDir() {
    return mkdtempSync(join(tmpdir(), "oc-pilot-test-"));
}
test("languageFromPath maps common extensions", () => {
    assert.equal(languageFromPath("wallet.go"), "Go");
    assert.equal(languageFromPath("src/App.tsx"), "TypeScript");
    assert.equal(languageFromPath("README.md"), undefined);
});
test("changed files take priority over repository manifests", () => {
    const dir = tempDir();
    try {
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
        writeFileSync(join(dir, "tsconfig.json"), "{}");
        assert.equal(detectProjectType(dir, ["wallet.go"]), "Go");
        assert.equal(detectProjectType(dir, ["src/app.ts", "wallet.go"]), "Mixed (TypeScript, Go)");
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("manifests are used when the diff has no source files", () => {
    const dir = tempDir();
    try {
        writeFileSync(join(dir, "go.mod"), "module example.com/x\n");
        assert.equal(detectProjectType(dir, ["README.md"]), "Go");
        writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = \"x\"\n");
        assert.equal(detectProjectType(dir, ["README.md"]), "Mixed (Go, Rust)");
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("detectTestCommand reads package.json scripts", () => {
    const dir = tempDir();
    try {
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { test: "vitest run" } }));
        const result = detectTestCommand(dir);
        assert.equal(result?.command, "npm test");
        assert.match(result?.source ?? "", /scripts\.test/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("detectTestCommand ignores the npm placeholder script", () => {
    const dir = tempDir();
    try {
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
        assert.equal(detectTestCommand(dir), undefined);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("detectTestCommand supports Go and Rust", () => {
    const go = tempDir();
    const rust = tempDir();
    try {
        writeFileSync(join(go, "go.mod"), "module x\n");
        writeFileSync(join(rust, "Cargo.toml"), "[package]\n");
        assert.equal(detectTestCommand(go)?.command, "go test ./...");
        assert.equal(detectTestCommand(rust)?.command, "cargo test");
    }
    finally {
        rmSync(go, { recursive: true, force: true });
        rmSync(rust, { recursive: true, force: true });
    }
});
//# sourceMappingURL=project.test.js.map