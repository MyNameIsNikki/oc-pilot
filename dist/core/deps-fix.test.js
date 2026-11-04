import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { applyDependencyFixPlan, planDependencyFixes } from "./deps-fix.js";
import { auditDependencies } from "./deps-health.js";
function makeRepo(files) {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-deps-fix-"));
    spawnSync("git", ["init", "-q"], { cwd: dir });
    for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text, "utf8");
    }
    return dir;
}
function manifest(value) {
    return `${JSON.stringify({ name: "demo", private: true, ...value }, null, 2)}\n`;
}
function readManifest(dir) {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
}
test("moves a test-only dependency to devDependencies", () => {
    const dir = makeRepo({
        "package.json": manifest({ dependencies: { zod: "^3.23.0" } }),
        "src/app.test.ts": 'import { z } from "zod";\n',
    });
    try {
        const plan = planDependencyFixes(dir, auditDependencies(dir));
        assert.equal(plan.fixes.length, 1);
        assert.deepEqual(plan.fixes[0], {
            name: "zod",
            action: "move-to-dev",
            from: "dependencies:^3.23.0",
            to: "devDependencies:^3.23.0",
            reason: "используется только в тестах",
        });
        assert.equal(applyDependencyFixPlan(dir, plan), true);
        const updated = readManifest(dir);
        assert.deepEqual(updated.dependencies, undefined);
        assert.deepEqual(updated.devDependencies, { zod: "^3.23.0" });
        assert.deepEqual(auditDependencies(dir).issues, []);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("adds a phantom import using the lockfile version", () => {
    const dir = makeRepo({
        "package.json": manifest({}),
        "app.ts": 'import axios from "axios";\n',
        "package-lock.json": JSON.stringify({
            lockfileVersion: 3,
            packages: { "": {}, "node_modules/axios": { version: "1.7.2" } },
        }),
    });
    try {
        const plan = planDependencyFixes(dir, auditDependencies(dir));
        assert.deepEqual(plan.fixes, [
            {
                name: "axios",
                action: "add-prod",
                to: "dependencies:^1.7.2",
                reason: "импортируется, версия 1.7.2 уже в lockfile",
            },
        ]);
        applyDependencyFixPlan(dir, plan);
        assert.deepEqual(readManifest(dir).dependencies, { axios: "^1.7.2" });
        assert.deepEqual(auditDependencies(dir).issues, []);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("adds a phantom import used only by tests to devDependencies", () => {
    const dir = makeRepo({
        "package.json": manifest({}),
        "src/app.test.ts": 'import { render } from "@testing-library/react";\n',
        "package-lock.json": JSON.stringify({
            lockfileVersion: 3,
            packages: { "": {}, "node_modules/@testing-library/react": { version: "16.0.0" } },
        }),
    });
    try {
        const plan = planDependencyFixes(dir, auditDependencies(dir));
        assert.equal(plan.fixes[0]?.action, "add-dev");
        applyDependencyFixPlan(dir, plan);
        assert.deepEqual(readManifest(dir).devDependencies, { "@testing-library/react": "^16.0.0" });
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("skips a phantom import without a lockfile version", () => {
    const dir = makeRepo({
        "package.json": manifest({}),
        "app.ts": 'import axios from "axios";\n',
    });
    try {
        const before = readFileSync(join(dir, "package.json"), "utf8");
        const plan = planDependencyFixes(dir, auditDependencies(dir));
        assert.deepEqual(plan.fixes, []);
        assert.equal(plan.skipped.length, 1);
        assert.equal(plan.skipped[0]?.name, "axios");
        assert.match(plan.skipped[0]?.reason ?? "", /package-lock/);
        assert.equal(plan.after, before);
        assert.equal(applyDependencyFixPlan(dir, plan), false);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("pins a floating range to the lockfile version", () => {
    const dir = makeRepo({
        "package.json": manifest({ dependencies: { lodash: "*" } }),
        "app.ts": 'import lodash from "lodash";\n',
        "package-lock.json": JSON.stringify({
            lockfileVersion: 3,
            packages: { "": {}, "node_modules/lodash": { version: "4.17.21" } },
        }),
    });
    try {
        const plan = planDependencyFixes(dir, auditDependencies(dir));
        assert.deepEqual(plan.fixes, [
            {
                name: "lodash",
                action: "pin",
                from: "*",
                to: "^4.17.21",
                reason: "версия взята из lockfile",
            },
        ]);
        applyDependencyFixPlan(dir, plan);
        assert.deepEqual(readManifest(dir).dependencies, { lodash: "^4.17.21" });
        assert.deepEqual(auditDependencies(dir).issues, []);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("leaves removals, duplicates and vcs specs to the user", () => {
    const dir = makeRepo({
        "package.json": manifest({
            dependencies: { "left-pad": "^1.3.0", moment: "^2.30.0", dayjs: "^1.11.0" },
            devDependencies: { "local-lib": "file:../local" },
        }),
        "app.ts": 'import moment from "moment";\nimport dayjs from "dayjs";\nimport lib from "local-lib";\n',
    });
    try {
        const plan = planDependencyFixes(dir, auditDependencies(dir));
        assert.deepEqual(plan.fixes, []);
        const kinds = plan.skipped.map((item) => item.kind).sort();
        assert.deepEqual(kinds, ["duplicate", "unused", "vcs"]);
        assert.ok(plan.skipped.every((item) => item.reason.length > 0));
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("planning does not touch package.json", () => {
    const dir = makeRepo({
        "package.json": manifest({ dependencies: { zod: "^3.23.0" } }),
        "src/app.test.ts": 'import { z } from "zod";\n',
    });
    try {
        const before = readFileSync(join(dir, "package.json"), "utf8");
        const plan = planDependencyFixes(dir, auditDependencies(dir));
        assert.equal(plan.fixes.length, 1);
        assert.equal(readFileSync(join(dir, "package.json"), "utf8"), before);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=deps-fix.test.js.map