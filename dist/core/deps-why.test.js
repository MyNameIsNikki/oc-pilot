import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { explainDependency, renderDependencyWhy } from "./deps-why.js";
function makeRepo(files) {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-deps-why-"));
    spawnSync("git", ["init", "-q"], { cwd: dir });
    for (const [path, text] of Object.entries(files)) {
        const target = join(dir, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, text, "utf8");
    }
    return dir;
}
function manifest(value) {
    return JSON.stringify({ name: "demo", private: true, ...value }, null, 2);
}
function lockfile(packages) {
    return JSON.stringify({ name: "demo", lockfileVersion: 3, packages: { "": { name: "demo" }, ...packages } }, null, 2);
}
test("explainDependency follows a transitive chain from package.json", () => {
    const dir = makeRepo({
        "package.json": manifest({ dependencies: { express: "^4.18.0" } }),
        "package-lock.json": lockfile({
            "node_modules/express": { version: "4.18.2", dependencies: { "body-parser": "1.20.1" } },
            "node_modules/body-parser": { version: "1.20.1", dependencies: { qs: "6.11.0" } },
            "node_modules/qs": { version: "6.11.0" },
        }),
        "src/app.ts": 'import express from "express";\n',
    });
    try {
        const why = explainDependency(dir, "qs");
        assert.ok(why);
        assert.deepEqual(why.versions, ["6.11.0"]);
        assert.equal(why.copies, 1);
        assert.equal(why.declared, null);
        assert.deepEqual(why.importedBy, []);
        assert.deepEqual(why.dependents, ["body-parser"]);
        assert.deepEqual(why.chains, [["express", "body-parser", "qs"]]);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("explainDependency reports a declared dev dependency and its import", () => {
    const dir = makeRepo({
        "package.json": manifest({ devDependencies: { vitest: "^1.6.0" } }),
        "package-lock.json": lockfile({ "node_modules/vitest": { version: "1.6.0" } }),
        "src/a.test.ts": 'import { test } from "vitest";\n',
    });
    try {
        const why = explainDependency(dir, "vitest");
        assert.ok(why);
        assert.deepEqual(why.declared, { field: "dev", spec: "^1.6.0" });
        assert.deepEqual(why.importedBy, ["src/a.test.ts"]);
        assert.deepEqual(why.chains, [["vitest"]]);
        assert.deepEqual(why.dependents, []);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("explainDependency counts nested copies and resolves each chain", () => {
    const dir = makeRepo({
        "package.json": manifest({ dependencies: { a: "^1.0.0", b: "^1.0.0" } }),
        "package-lock.json": lockfile({
            "node_modules/a": { version: "1.0.0", dependencies: { shared: "^2.0.0" } },
            "node_modules/a/node_modules/shared": { version: "2.0.0" },
            "node_modules/b": { version: "1.0.0", dependencies: { shared: "^1.0.0" } },
            "node_modules/shared": { version: "1.0.0" },
        }),
        "src/app.ts": 'import a from "a";\nimport b from "b";\n',
    });
    try {
        const why = explainDependency(dir, "shared");
        assert.ok(why);
        assert.equal(why.copies, 2);
        assert.deepEqual(why.versions, ["1.0.0", "2.0.0"]);
        assert.deepEqual(why.dependents, ["a", "b"]);
        assert.deepEqual(why.chains, [
            ["a", "shared"],
            ["b", "shared"],
        ]);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("explainDependency reads a v1 lockfile tree", () => {
    const dir = makeRepo({
        "package.json": manifest({ dependencies: { express: "^4.18.0" } }),
        "package-lock.json": JSON.stringify({
            name: "demo",
            lockfileVersion: 1,
            dependencies: {
                express: { version: "4.18.2", dependencies: { qs: { version: "6.11.0" } } },
            },
        }),
        "src/app.ts": 'const express = require("express");\n',
    });
    try {
        const why = explainDependency(dir, "qs");
        assert.ok(why);
        assert.deepEqual(why.versions, ["6.11.0"]);
        assert.deepEqual(why.chains, [["express", "qs"]]);
        assert.deepEqual(why.importedBy, []);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("explainDependency returns undefined for a package that is nowhere", () => {
    const dir = makeRepo({
        "package.json": manifest({ dependencies: { react: "^18.0.0" } }),
        "src/app.ts": 'import react from "react";\n',
    });
    try {
        assert.equal(explainDependency(dir, "left-pad"), undefined);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("explainDependency handles a declared package without a lockfile", () => {
    const dir = makeRepo({
        "package.json": manifest({ dependencies: { react: "^18.0.0" } }),
        "src/app.ts": 'import react from "react";\n',
    });
    try {
        const why = explainDependency(dir, "react");
        assert.ok(why);
        assert.deepEqual(why.declared, { field: "prod", spec: "^18.0.0" });
        assert.equal(why.copies, 0);
        assert.deepEqual(why.versions, []);
        assert.deepEqual(why.chains, []);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("explainDependency rejects an empty package name", () => {
    const dir = makeRepo({ "package.json": manifest({}) });
    try {
        assert.throws(() => explainDependency(dir, "  "), /Не указано имя пакета/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("renderDependencyWhy prints chains and declaration", () => {
    const dir = makeRepo({
        "package.json": manifest({ dependencies: { express: "^4.18.0" } }),
        "package-lock.json": lockfile({
            "node_modules/express": { version: "4.18.2", dependencies: { qs: "6.11.0" } },
            "node_modules/qs": { version: "6.11.0" },
        }),
    });
    try {
        const why = explainDependency(dir, "qs");
        assert.ok(why);
        const text = renderDependencyWhy(why);
        assert.match(text, /Пакет: qs/);
        assert.match(text, /Версии в lockfile: 6\.11\.0 \(1 копия\)/);
        assert.match(text, /В package\.json не объявлен/);
        assert.match(text, /Зависит от него: express/);
        assert.match(text, /express → qs/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=deps-why.test.js.map