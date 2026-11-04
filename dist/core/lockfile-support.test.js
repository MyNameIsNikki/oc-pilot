import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { auditDependencies } from "./deps-health.js";
import { planDependencyFixes } from "./deps-fix.js";
import { explainDependency } from "./deps-why.js";
function makeRepo(files) {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-lock-support-"));
    spawnSync("git", ["init", "-q"], { cwd: dir });
    for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text, "utf8");
    }
    return dir;
}
function manifest(value) {
    return JSON.stringify({ name: "demo", private: true, ...value }, null, 2);
}
const PNPM_HEADER = ["lockfileVersion: '6.0'", "packages:"];
test("deps health reads a pnpm lockfile and names the pnpm command", () => {
    const dir = makeRepo({
        "package.json": manifest({ dependencies: { lodash: "^4.17.21", zod: "^3.22.0" } }),
        "app.ts": 'import lodash from "lodash";\n',
        "pnpm-lock.yaml": [...PNPM_HEADER, "  /lodash@4.17.21:", "    resolution: {integrity: sha512-a}", ""].join("\n"),
    });
    try {
        const report = auditDependencies(dir);
        assert.equal(report.lockfile, "pnpm-lock.yaml");
        const missing = report.issues.find((issue) => issue.kind === "lockfile" && issue.name === "zod");
        assert.equal(missing?.severity, "high");
        assert.match(missing?.message ?? "", /pnpm install --frozen-lockfile/);
        assert.equal(report.issues.some((issue) => issue.kind === "lockfile" && issue.name === "lodash"), false);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("deps fix takes a phantom version from the pnpm lockfile", () => {
    const dir = makeRepo({
        "package.json": manifest({ dependencies: { lodash: "^4.17.21" } }),
        "app.ts": 'import lodash from "lodash";\nimport axios from "axios";\n',
        "pnpm-lock.yaml": [
            ...PNPM_HEADER,
            "  /lodash@4.17.21:",
            "    resolution: {integrity: sha512-a}",
            "  /axios@1.7.2:",
            "    resolution: {integrity: sha512-b}",
            "",
        ].join("\n"),
    });
    try {
        const plan = planDependencyFixes(dir, auditDependencies(dir));
        assert.deepEqual(plan.fixes.map((fix) => [fix.name, fix.action, fix.to]), [["axios", "add-prod", "dependencies:^1.7.2"]]);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("deps why walks a flat pnpm graph", () => {
    const dir = makeRepo({
        "package.json": manifest({ dependencies: { express: "^4.18.0" } }),
        "app.ts": 'import express from "express";\n',
        "pnpm-lock.yaml": [
            ...PNPM_HEADER,
            "  /express@4.18.0:",
            "    resolution: {integrity: sha512-a}",
            "    dependencies:",
            "      body-parser: 1.20.0",
            "  /body-parser@1.20.0:",
            "    resolution: {integrity: sha512-b}",
            "    dependencies:",
            "      qs: 6.11.0",
            "  /qs@6.11.0:",
            "    resolution: {integrity: sha512-c}",
            "",
        ].join("\n"),
    });
    try {
        const why = explainDependency(dir, "qs");
        assert.deepEqual(why?.versions, ["6.11.0"]);
        assert.equal(why?.copies, 1);
        assert.deepEqual(why?.dependents, ["body-parser"]);
        assert.deepEqual(why?.chains, [["express", "body-parser", "qs"]]);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("deps health reads a yarn lockfile", () => {
    const dir = makeRepo({
        "package.json": manifest({ dependencies: { lodash: "^4.17.21" } }),
        "app.ts": 'import lodash from "lodash";\n',
        "yarn.lock": [
            'lodash@^4.17.21:',
            '  version "4.17.21"',
            '  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz"',
            "",
        ].join("\n"),
    });
    try {
        const report = auditDependencies(dir);
        assert.equal(report.lockfile, "yarn.lock");
        assert.deepEqual(report.issues, []);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=lockfile-support.test.js.map