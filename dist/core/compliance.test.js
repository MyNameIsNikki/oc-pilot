import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildComplianceManifest, saveComplianceManifest, signComplianceManifest, verifyComplianceManifest, } from "./compliance.js";
import { buildReceipt, saveReceipt } from "./receipt.js";
const PREFLIGHT = {
    status: "pass",
    checks: [
        { id: "sast", label: "SAST", status: "pass", summary: "находок нет", details: [] },
        { id: "tests", label: "Тесты", status: "pass", summary: "пройдены", details: [] },
    ],
    diff: { source: "git diff HEAD", files: 1, additions: 3, deletions: 0 },
};
function makeRepo() {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-compliance-"));
    spawnSync("git", ["init", "-q"], { cwd: dir });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
    writeFileSync(join(dir, "app.ts"), "export const value = 1;\n", "utf8");
    spawnSync("git", ["add", "."], { cwd: dir });
    spawnSync("git", ["commit", "-m", "init"], { cwd: dir });
    return dir;
}
function writeReceipt(cwd) {
    const body = {
        version: 1,
        tool: "oc-pilot",
        toolVersion: "0.70.0",
        createdAt: new Date().toISOString(),
        commit: null,
        branch: null,
        dirty: false,
        diff: { files: 1, additions: 3, deletions: 0 },
        files: ["app.ts"],
        tests: { command: "npm test", exitCode: 0, timedOut: false, durationMs: 10, passed: true, outputTail: "" },
        preflight: PREFLIGHT,
    };
    saveReceipt(cwd, buildReceipt(body));
}
test("compliance builds a manifest from a receipt and verifies it", () => {
    const dir = makeRepo();
    try {
        writeReceipt(dir);
        const manifest = buildComplianceManifest(dir);
        assert.ok(manifest.commit);
        assert.equal(manifest.receipt?.ok, true);
        assert.equal(manifest.checks.length, 2);
        assert.equal(manifest.tests?.passed, true);
        assert.equal(manifest.previous, null);
        const verification = verifyComplianceManifest(dir, manifest);
        assert.equal(verification.hashOk, true);
        assert.equal(verification.commitOk, true);
        assert.equal(verification.chainOk, true);
        assert.equal(verification.ok, true);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("compliance detects a tampered manifest", () => {
    const dir = makeRepo();
    try {
        const manifest = buildComplianceManifest(dir);
        const tampered = { ...manifest, model: "attacker" };
        const verification = verifyComplianceManifest(dir, tampered);
        assert.equal(verification.hashOk, false);
        assert.equal(verification.ok, false);
        assert.match(verification.reason ?? "", /хеш/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("compliance chains manifests through the previous hash", () => {
    const dir = makeRepo();
    try {
        const first = buildComplianceManifest(dir);
        saveComplianceManifest(dir, first);
        const second = buildComplianceManifest(dir);
        assert.equal(second.previous, first.hash);
        saveComplianceManifest(dir, second);
        const verification = verifyComplianceManifest(dir, second);
        assert.equal(verification.chainOk, true);
        assert.equal(verification.ok, true);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("compliance signs and verifies a manifest with ed25519", () => {
    const dir = makeRepo();
    try {
        const { privateKey, publicKey } = generateKeyPairSync("ed25519");
        const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
        const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
        const manifest = signComplianceManifest(buildComplianceManifest(dir), privatePem);
        assert.ok(manifest.signature);
        const verification = verifyComplianceManifest(dir, manifest, { publicKeyPem: publicPem });
        assert.equal(verification.signature, "valid");
        assert.equal(verification.ok, true);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("compliance tolerates a missing receipt", () => {
    const dir = makeRepo();
    try {
        const manifest = buildComplianceManifest(dir);
        assert.equal(manifest.receipt, null);
        assert.deepEqual(manifest.checks, []);
        assert.equal(manifest.tests, null);
        assert.equal(verifyComplianceManifest(dir, manifest).ok, true);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=compliance.test.js.map