import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { resolveHookBinary } from "./hooks.js";
function makeDir() {
    return mkdtempSync(join(tmpdir(), "oc-pilot-hook-binary-"));
}
function writeBinary(path, platform) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "#!/bin/sh\nexit 0\n", "utf8");
    if (platform !== "win32")
        chmodSync(path, 0o755);
}
function localBinary(dir, platform) {
    const name = platform === "win32" ? "oc-pilot.cmd" : "oc-pilot";
    return join(dir, "node_modules", ".bin", name);
}
test("resolveHookBinary finds the project-local binary", () => {
    const dir = makeDir();
    try {
        const binary = localBinary(dir, process.platform);
        writeBinary(binary, process.platform);
        assert.equal(resolveHookBinary(dir, { env: { PATH: "" }, platform: process.platform }), binary);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("resolveHookBinary honors OC_PILOT_BIN as an absolute path", () => {
    const dir = makeDir();
    try {
        const binary = join(dir, "custom", "oc-pilot");
        writeBinary(binary, process.platform);
        assert.equal(resolveHookBinary(dir, {
            env: { OC_PILOT_BIN: binary, PATH: "" },
            platform: process.platform,
        }), binary);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("resolveHookBinary resolves a relative OC_PILOT_BIN from the project root", () => {
    const dir = makeDir();
    try {
        const binary = join(dir, "bin", "oc-pilot");
        writeBinary(binary, process.platform);
        assert.equal(resolveHookBinary(dir, {
            env: { OC_PILOT_BIN: "./bin/oc-pilot", PATH: "" },
            platform: process.platform,
        }), binary);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("resolveHookBinary falls back to PATH", () => {
    const dir = makeDir();
    try {
        const binary = localBinary(dir, process.platform);
        writeBinary(binary, process.platform);
        assert.equal(resolveHookBinary(dir, {
            env: { PATH: join(dir, "node_modules", ".bin") },
            platform: process.platform,
        }), binary);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("resolveHookBinary returns undefined when nothing is found", () => {
    const dir = makeDir();
    try {
        assert.equal(resolveHookBinary(dir, { env: { PATH: "" }, platform: process.platform }), undefined);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("resolveHookBinary does not fall back past an invalid OC_PILOT_BIN", () => {
    const dir = makeDir();
    try {
        const binary = localBinary(dir, process.platform);
        writeBinary(binary, process.platform);
        assert.equal(resolveHookBinary(dir, {
            env: { OC_PILOT_BIN: "./missing", PATH: "" },
            platform: process.platform,
        }), undefined);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=hooks.test.js.map