import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { auditDependencies, issueFailsGate, packageNameOf, } from "./deps-health.js";
function makeRepo(files) {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-deps-health-"));
    const init = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
    if (init.status !== 0)
        throw new Error(`git init failed: ${init.stderr}`);
    for (const [path, text] of Object.entries(files)) {
        const full = join(dir, path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, text, "utf8");
    }
    return dir;
}
function manifest(value) {
    return JSON.stringify({ name: "demo", private: true, ...value }, null, 2);
}
function kinds(issues) {
    return issues.map((issue) => issue.kind);
}
test("flags imported packages that package.json does not declare", () => {
    const dir = makeRepo({
        "package.json": manifest({ dependencies: { react: "^18.0.0" } }),
        "src/app.ts": [
            'import React from "react";',
            'import axios from "axios";',
            'import { readFileSync } from "node:fs";',
            'import { helper } from "./local";',
        ].join("\n"),
    });
    try {
        const report = auditDependencies(dir);
        const phantom = report.issues.filter((issue) => issue.kind === "phantom");
        assert.deepEqual(phantom.map((issue) => issue.name), ["axios"]);
        assert.equal(phantom[0]?.severity, "high");
        assert.deepEqual(phantom[0]?.files, ["src/app.ts"]);
        assert.match(phantom[0]?.message ?? "", /не объявлен/);
        assert.equal(report.packageName, "demo");
        assert.equal(report.declared, 1);
        assert.ok(report.imported >= 2);
        assert.equal(report.scannedFiles, 1);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("packageNameOf normalizes scoped packages and skips builtins, URLs and relative paths", () => {
    assert.equal(packageNameOf("@scope/pkg/sub/deep"), "@scope/pkg");
    assert.equal(packageNameOf("pkg/sub"), "pkg");
    assert.equal(packageNameOf("lodash"), "lodash");
    assert.equal(packageNameOf("./local"), undefined);
    assert.equal(packageNameOf("../up"), undefined);
    assert.equal(packageNameOf("/absolute"), undefined);
    assert.equal(packageNameOf("#internal"), undefined);
    assert.equal(packageNameOf("node:fs"), undefined);
    assert.equal(packageNameOf("https://example.com/lib.js"), undefined);
    assert.equal(packageNameOf(""), undefined);
});
test("reports declared packages that nothing imports and keeps tooling quiet", () => {
    const dir = makeRepo({
        "package.json": manifest({
            dependencies: { "left-pad": "^1.3.0" },
            devDependencies: { eslint: "^9.0.0", "@types/node": "^22.0.0", tslib: "^2.0.0" },
            peerDependencies: { react: "^18.0.0" },
            scripts: { lint: "eslint ." },
        }),
        "src/app.ts": "export const value = 1;\n",
    });
    try {
        const report = auditDependencies(dir);
        const unused = report.issues.filter((issue) => issue.kind === "unused");
        assert.deepEqual(unused.map((issue) => issue.name), ["left-pad"]);
        assert.equal(unused[0]?.severity, "medium");
        assert.equal(report.declared, 5);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("flags production dependencies used only by tests", () => {
    const dir = makeRepo({
        "package.json": manifest({ dependencies: { zod: "^3.23.0" } }),
        "src/app.ts": "export const value = 1;\n",
        "src/app.test.ts": 'import { z } from "zod";\n',
    });
    try {
        const report = auditDependencies(dir);
        const misplaced = report.issues.filter((issue) => issue.kind === "misplaced");
        assert.deepEqual(misplaced.map((issue) => issue.name), ["zod"]);
        assert.equal(misplaced[0]?.severity, "low");
        assert.deepEqual(misplaced[0]?.files, ["src/app.test.ts"]);
        assert.ok(!kinds(report.issues).includes("unused"));
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("flags overlapping libraries, unpinned specs and vcs references", () => {
    const dir = makeRepo({
        "package.json": manifest({
            dependencies: {
                moment: "^2.30.0",
                dayjs: "^1.11.0",
                lodash: "*",
                "left-pad": "git+https://github.com/user/left-pad.git",
                "local-lib": "file:../local",
            },
        }),
        "src/app.ts": ['import moment from "moment";', 'import dayjs from "dayjs";', 'import _ from "lodash";'].join("\n"),
    });
    try {
        const report = auditDependencies(dir);
        const duplicate = report.issues.find((issue) => issue.kind === "duplicate");
        assert.equal(duplicate?.name, "moment, dayjs");
        const unpinned = report.issues.find((issue) => issue.kind === "unpinned");
        assert.equal(unpinned?.name, "lodash");
        assert.equal(unpinned?.severity, "medium");
        const vcs = report.issues.filter((issue) => issue.kind === "vcs");
        assert.deepEqual(vcs.map((issue) => [issue.name, issue.severity]), [
            ["left-pad", "high"],
            ["local-lib", "low"],
        ]);
        assert.equal(issueFailsGate(report.issues, "high"), true);
        assert.equal(issueFailsGate([], "low"), false);
        assert.equal(issueFailsGate([unpinned], "high"), false);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("flags declared packages missing from package-lock.json", () => {
    const dir = makeRepo({
        "package.json": manifest({ dependencies: { zod: "^3.23.0", lodash: "^4.17.21" } }),
        "src/app.ts": ['import { z } from "zod";', 'import _ from "lodash";'].join("\n"),
        "package-lock.json": JSON.stringify({
            lockfileVersion: 3,
            packages: { "": {}, "node_modules/lodash": { version: "4.17.21" } },
        }),
    });
    try {
        const report = auditDependencies(dir);
        assert.equal(report.lockfile, "package-lock.json");
        const lockIssues = report.issues.filter((issue) => issue.kind === "lockfile");
        assert.deepEqual(lockIssues.map((issue) => issue.name), ["zod"]);
        assert.equal(lockIssues[0]?.severity, "high");
        assert.ok(!lockIssues.some((issue) => issue.name === "lodash"));
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("workspace packages are not phantom dependencies", () => {
    const dir = makeRepo({
        "package.json": manifest({ workspaces: ["packages/*"] }),
        "packages/ui/package.json": JSON.stringify({ name: "@app/ui", version: "0.0.0" }),
        "packages/ui/index.ts": "export const button = 1;\n",
        "src/app.ts": 'import { button } from "@app/ui";\n',
    });
    try {
        const report = auditDependencies(dir);
        assert.ok(!report.issues.some((issue) => issue.kind === "phantom"));
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("ignore skips noisy packages", () => {
    const dir = makeRepo({
        "package.json": manifest({ dependencies: { zod: "^3.23.0" } }),
        "src/app.ts": "export const value = 1;\n",
    });
    try {
        const report = auditDependencies(dir, { ignore: ["zod"] });
        assert.deepEqual(report.issues, []);
        assert.equal(report.declared, 1);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("string literals that look like imports are not phantom dependencies", () => {
    const dir = makeRepo({
        "package.json": manifest({ dependencies: {} }),
        "src/gen.test.ts": "const sample = 'import axios from \"axios\";\\n';\n",
        "src/template.test.ts": "const sample = `\nimport express from \"express\";\n`;\n",
        "src/require.test.ts": "const sample = 'const chalk = require(\"chalk\");\n';\n",
        "src/dynamic.test.ts": "const sample = 'await import(\"vitest\");\n';\n",
    });
    try {
        const report = auditDependencies(dir);
        assert.deepEqual(report.issues.filter((issue) => issue.kind === "phantom").map((issue) => issue.name), []);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("real import forms are still detected", () => {
    const dir = makeRepo({
        "package.json": manifest({ dependencies: {} }),
        "src/single.ts": 'import axios from "axios";\n',
        "src/multi.ts": 'import {\n  z\n} from "zod";\n',
        "src/cjs.js": 'const leftPad = require("left-pad");\n',
        "src/dynamic.ts": 'const mod = await import("chalk");\n',
    });
    try {
        const report = auditDependencies(dir);
        assert.deepEqual(report.issues
            .filter((issue) => issue.kind === "phantom")
            .map((issue) => issue.name)
            .sort(), ["axios", "chalk", "left-pad", "zod"]);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("missing package.json raises a usage error", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-deps-health-empty-"));
    try {
        assert.throws(() => auditDependencies(dir), /package\.json не найден/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=deps-health.test.js.map