import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanTree } from "./tree-scan.js";
const AWS_KEY = ["AKIA", "Q2WSXEDCRFVTGBYH"].join("");
function git(args, cwd) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0)
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}
function makeRepo() {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-tree-scan-"));
    git(["init"], dir);
    git(["config", "user.email", "test@example.com"], dir);
    git(["config", "user.name", "Test"], dir);
    git(["config", "core.autocrlf", "false"], dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "vendor"), { recursive: true });
    mkdirSync(join(dir, ".oc-pilot"), { recursive: true });
    writeFileSync(join(dir, ".gitignore"), ".env.local\n");
    writeFileSync(join(dir, ".oc-pilot", "ignore"), "vendor/**\n");
    writeFileSync(join(dir, "src", "config.ts"), `export const key = "${AWS_KEY}";\n`);
    writeFileSync(join(dir, "src", "clean.ts"), "export const answer = 42;\n");
    writeFileSync(join(dir, ".env.local"), `SECRET=${AWS_KEY}\n`);
    writeFileSync(join(dir, "vendor", "lib.ts"), `export const vendorKey = "${AWS_KEY}";\n`);
    git(["add", "."], dir);
    git(["commit", "-m", "init"], dir);
    return dir;
}
test("scanTree reports secrets in project files only", () => {
    const dir = makeRepo();
    try {
        const result = scanTree(dir);
        assert.equal(result.findings.length, 1);
        assert.equal(result.findings[0]?.file, "src/config.ts");
        assert.equal(result.findings[0]?.line, 1);
        assert.match(result.findings[0]?.kind ?? "", /AWS/i);
        assert.ok(result.files >= 2, `expected a few scanned files, got ${result.files}`);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("scanTree keeps reporting after an ignored directory", () => {
    const dir = makeRepo();
    try {
        writeFileSync(join(dir, "src", "later.ts"), `export const token = "${AWS_KEY}";\n`);
        const result = scanTree(dir);
        assert.deepEqual(result.findings.map((finding) => finding.file).sort(), ["src/config.ts", "src/later.ts"]);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=tree-scan.test.js.map