import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildBounty, describeBounty } from "./bounty.js";
function git(args, cwd) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
}
function makeRepo(files) {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-bounty-"));
    git(["init", "-q"], dir);
    git(["config", "user.email", "test@example.com"], dir);
    git(["config", "user.name", "Test"], dir);
    git(["config", "core.autocrlf", "false"], dir);
    for (const [path, content] of Object.entries(files)) {
        const full = join(dir, path);
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, content, "utf8");
    }
    git(["add", "."], dir);
    git(["commit", "-m", "init"], dir);
    return dir;
}
test("buildBounty ranks the file with a SAST finding and an old TODO", () => {
    const dir = makeRepo({
        "src/app.js": [
            'const { exec } = require("child_process");',
            "// TODO: remove the debug command",
            "exec(req.query.cmd);",
            "",
        ].join("\n"),
        "src/clean.js": "export const value = 1;\n",
    });
    try {
        const report = buildBounty(dir);
        assert.equal(report.file, "src/app.js");
        assert.ok(report.score > 0, `score ${String(report.score)}`);
        const kinds = report.candidates[0]?.reasons.map((reason) => reason.kind) ?? [];
        assert.ok(kinds.includes("sast"), `kinds: ${kinds.join(",")}`);
        assert.ok(kinds.includes("todo"), `kinds: ${kinds.join(",")}`);
        assert.match(report.poster, /W\s*A\s*N\s*T\s*E\s*D/);
        assert.match(report.poster, /src\/app\.js/);
        assert.match(describeBounty(report), /Худший файл: src\/app\.js/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("buildBounty is deterministic for equal scores", () => {
    const dir = makeRepo({
        "src/b.js": "// TODO: second\nexport const b = 2;\n",
        "src/a.js": "// TODO: first\nexport const a = 1;\n",
    });
    try {
        const first = buildBounty(dir);
        const second = buildBounty(dir);
        assert.deepEqual(first.candidates.map((candidate) => candidate.file), second.candidates.map((candidate) => candidate.file));
        assert.equal(first.file, "src/a.js");
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("buildBounty reports a clean repository", () => {
    const dir = makeRepo({ "README.md": "# demo\n" });
    try {
        const report = buildBounty(dir);
        assert.equal(report.file, null);
        assert.equal(report.score, 0);
        assert.match(report.poster, /Пока чисто/);
        assert.match(describeBounty(report), /Розыск не требуется/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=bounty.test.js.map