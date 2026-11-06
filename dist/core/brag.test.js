import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildBrag } from "./brag.js";
function makeRepo() {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-brag-"));
    spawnSync("git", ["init", "-q"], { cwd: dir });
    return dir;
}
test("buildBrag renders a self-contained HTML report", () => {
    const dir = makeRepo();
    try {
        const report = buildBrag(dir, { title: "Sprint report", sinceDays: 14 });
        assert.equal(report.title, "Sprint report");
        assert.equal(report.sinceDays, 14);
        assert.match(report.content, /^<!doctype html>/i);
        assert.match(report.content, /Sprint report/);
        assert.match(report.content, /made with oc-pilot/);
        assert.match(report.content, /<style>/);
        assert.match(report.content, /<svg/);
        assert.ok(!/<script\s+src=/i.test(report.content), "report must not load external scripts");
        assert.ok(!/<link\s+[^>]*href=/i.test(report.content), "report must not load external styles");
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("buildBrag escapes the title and renders standalone SVG", () => {
    const dir = makeRepo();
    try {
        const report = buildBrag(dir, { title: "<script>alert(1)</script>", svg: true });
        assert.match(report.content, /^<svg/);
        assert.ok(!report.content.includes("<script>alert(1)</script>"));
        assert.match(report.content, /&lt;script&gt;/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=brag.test.js.map