import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runReplay } from "./replay.js";
import { PilotError } from "../core/errors.js";
const FINDINGS = [
    { severity: "critical", location: "wallet.go:10", text: "nil dereference after Close" },
    { severity: "warning", location: "src/api/handler.ts:42", text: "error is swallowed" },
];
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-replay-"));
    const reviewPath = join(dir, "review.json");
    writeFileSync(reviewPath, JSON.stringify({ version: 1, createdAt: "2026-01-01T00:00:00.000Z", recipe: "review", model: "test-model", findings: FINDINGS }), "utf8");
    return { dir, reviewPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
test("replay writes the saved review as JSON", () => {
    const { dir, reviewPath, cleanup } = fixture();
    try {
        const out = join(dir, "out.json");
        assert.equal(runReplay(["--cwd", dir, "--in", reviewPath, "--format", "json", "-o", out]), 0);
        const parsed = JSON.parse(readFileSync(out, "utf8"));
        assert.equal(parsed.recipe, "review");
        assert.equal(parsed.findings.length, 2);
    }
    finally {
        cleanup();
    }
});
test("replay converts findings to SARIF", () => {
    const { dir, reviewPath, cleanup } = fixture();
    try {
        const out = join(dir, "out.sarif");
        assert.equal(runReplay(["--cwd", dir, "--in", reviewPath, "--format", "sarif", "-o", out]), 0);
        const sarif = JSON.parse(readFileSync(out, "utf8"));
        assert.equal(sarif.version, "2.1.0");
        const results = sarif.runs[0]?.results ?? [];
        assert.equal(results.length, 2);
        assert.equal(results[0]?.level, "error");
    }
    finally {
        cleanup();
    }
});
test("replay renders a markdown comment", () => {
    const { dir, reviewPath, cleanup } = fixture();
    try {
        const out = join(dir, "comment.md");
        assert.equal(runReplay(["--cwd", dir, "--in", reviewPath, "--as", "md", "-o", out]), 0);
        const text = readFileSync(out, "utf8");
        assert.match(text, /wallet\.go:10/);
        assert.match(text, /nil dereference/);
    }
    finally {
        cleanup();
    }
});
test("replay renders plain text with the review header", () => {
    const { dir, reviewPath, cleanup } = fixture();
    try {
        const out = join(dir, "out.txt");
        assert.equal(runReplay(["--cwd", dir, "--in", reviewPath, "-o", out]), 0);
        const text = readFileSync(out, "utf8");
        assert.match(text, /Ревью: 2026-01-01/);
        assert.match(text, /рецепт review/);
        assert.match(text, /Находок: 2/);
    }
    finally {
        cleanup();
    }
});
test("replay works from a bare findings array", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-replay-bare-"));
    try {
        const reviewPath = join(dir, "bare.json");
        writeFileSync(reviewPath, JSON.stringify({ findings: FINDINGS }), "utf8");
        const out = join(dir, "out.json");
        assert.equal(runReplay(["--cwd", dir, "--in", reviewPath, "--format", "json", "-o", out]), 0);
        assert.equal(JSON.parse(readFileSync(out, "utf8")).findings.length, 2);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("replay fails when no review was saved", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-replay-empty-"));
    try {
        assert.throws(() => runReplay(["--cwd", dir]), (error) => {
            assert.ok(error instanceof PilotError);
            assert.match(error.message, /Сохранённого ревью нет/);
            assert.match(error.hint ?? "", /last-review\.json/);
            assert.equal(error.exitCode, 2);
            return true;
        });
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("replay returns 3 when findings reach the fail-on threshold", () => {
    const { dir, reviewPath, cleanup } = fixture();
    try {
        assert.equal(runReplay(["--cwd", dir, "--in", reviewPath, "--format", "json", "--fail-on", "critical"]), 3);
        assert.equal(runReplay(["--cwd", dir, "--in", reviewPath, "--format", "json", "--fail-on", "none"]), 0);
    }
    finally {
        cleanup();
    }
});
test("an unknown replay format is a usage error", () => {
    const { dir, reviewPath, cleanup } = fixture();
    try {
        assert.throws(() => runReplay(["--cwd", dir, "--in", reviewPath, "--as", "yaml"]), (error) => {
            assert.ok(error instanceof PilotError);
            assert.match(error.message, /Неизвестный формат/);
            assert.equal(error.exitCode, 2);
            return true;
        });
    }
    finally {
        cleanup();
    }
});
//# sourceMappingURL=replay.test.js.map