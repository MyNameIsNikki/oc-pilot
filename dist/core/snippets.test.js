import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { extractSnippets } from "./snippets.js";
function tempDir() {
    return mkdtempSync(join(tmpdir(), "oc-pilot-snippets-"));
}
test("extractSnippets reads the reported line and nearby context", () => {
    const dir = tempDir();
    try {
        mkdirSync(join(dir, "src"));
        const file = join(dir, "src", "math.ts");
        writeFileSync(file, Array.from({ length: 20 }, (_, index) => `export const line${index + 1} = ${index + 1};`).join("\n"));
        const output = `Error: expected 0, got -5\n    at deduct (${file}:5:3)\n`;
        const result = extractSnippets(output, dir);
        assert.deepEqual(result.files, ["src/math.ts"]);
        assert.ok(result.text.includes("src/math.ts:5"));
        assert.ok(result.text.includes("line5"));
        assert.ok(result.text.includes("line1"));
        assert.match(result.text, />\s+5 \|/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("extractSnippets ignores node_modules and missing files", () => {
    const dir = tempDir();
    try {
        mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
        const ignored = join(dir, "node_modules", "pkg", "index.js");
        writeFileSync(ignored, "module.exports = 1;\n");
        const result = extractSnippets(`at ${ignored}:1:1\nat ${join(dir, "missing.go")}:2`, dir);
        assert.equal(result.files.length, 0);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("extractSnippets handles Python tracebacks", () => {
    const dir = tempDir();
    try {
        const file = join(dir, "wallet.py");
        writeFileSync(file, ["def deduct(u, amount):", "    u.balance -= amount", "    return u"].join("\n"));
        const output = `Traceback (most recent call last):\n  File "${file}", line 2, in deduct\n`;
        const result = extractSnippets(output, dir);
        assert.deepEqual(result.files, ["wallet.py"]);
        assert.ok(result.text.includes("u.balance -= amount"));
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=snippets.test.js.map