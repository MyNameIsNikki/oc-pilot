import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assessReadiness, renderBadge, renderReadiness } from "./readiness.js";
import { saveFindingsBaseline, sastFingerprint } from "./findings-baseline.js";
import { scanSource } from "./sast.js";
import { RECEIPT_VERSION, buildReceipt, generateReceiptKeyPair, saveReceipt, signReceipt } from "./receipt.js";
const PREFLIGHT = {
    status: "pass",
    checks: [],
    diff: { source: "git diff HEAD", files: 0, additions: 0, deletions: 0 },
};
function makeRepo(files) {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-ready-"));
    spawnSync("git", ["init", "-q"], { cwd: dir });
    for (const [path, content] of Object.entries(files)) {
        const full = join(dir, path);
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, content, "utf8");
    }
    return dir;
}
function commit(dir) {
    spawnSync("git", ["add", "-A"], { cwd: dir });
    spawnSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "init"], {
        cwd: dir,
    });
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" });
    return head.stdout.trim();
}
function saveReadyReceipt(dir, sha) {
    saveReceipt(dir, buildReceipt({
        version: RECEIPT_VERSION,
        tool: "oc-pilot",
        toolVersion: "0.38.0",
        createdAt: "2026-11-05T00:00:00.000Z",
        commit: sha,
        branch: "main",
        dirty: false,
        diff: { files: 0, additions: 0, deletions: 0 },
        files: [],
        tests: null,
        preflight: PREFLIGHT,
    }));
}
test("assessReadiness scores a prepared repository as agent-ready", () => {
    const dir = makeRepo({
        "package.json": JSON.stringify({ name: "demo", scripts: { test: "node -e \"process.exit(0)\"" } }, null, 2),
        "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }),
        "src/app.ts": "export const value = 1;\n",
        "AGENTS.md": "# Agent instructions\n",
        ".oc-pilot.json": "{}\n",
        ".github/workflows/ci.yml": "name: ci\n",
        ".git/hooks/pre-commit": "#!/bin/sh\n# oc-pilot hook v2\noc-pilot preflight --staged\n",
    });
    try {
        const sha = commit(dir);
        saveReadyReceipt(dir, sha);
        const report = assessReadiness(dir);
        assert.ok(report.score >= 85, `score ${String(report.score)}`);
        assert.equal(report.grade, "agent-ready");
        assert.equal(report.commit, sha);
        assert.deepEqual(report.checks.filter((check) => check.status !== "pass").map((check) => check.id), []);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("assessReadiness finds a hook installed through core.hooksPath", () => {
    const dir = makeRepo({
        ".githooks/pre-commit": "#!/bin/sh\n# oc-pilot hook v2\noc-pilot preflight --staged\n",
    });
    try {
        spawnSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: dir });
        const hooks = assessReadiness(dir).checks.find((check) => check.id === "hooks");
        assert.ok(hooks);
        assert.equal(hooks.status, "pass");
        assert.match(hooks.detail, /pre-commit/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("assessReadiness scores an empty repository as not ready", () => {
    const dir = makeRepo({});
    try {
        const report = assessReadiness(dir);
        assert.ok(report.score < 40, `score ${String(report.score)}`);
        assert.equal(report.grade, "not-ready");
        assert.equal(report.checks.find((check) => check.id === "tests")?.status, "fail");
        assert.equal(report.checks.find((check) => check.id === "hooks")?.status, "fail");
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("assessReadiness reports a corrupt lockfile", () => {
    const dir = makeRepo({
        "package.json": JSON.stringify({ name: "demo", dependencies: { "left-pad": "^1.3.0" } }, null, 2),
        "package-lock.json": "{not json",
    });
    try {
        const report = assessReadiness(dir);
        const lockfile = report.checks.find((check) => check.id === "lockfile");
        assert.ok(lockfile);
        assert.notEqual(lockfile.status, "pass");
        assert.ok(lockfile.points < lockfile.max);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("assessReadiness warns about a stale receipt", () => {
    const dir = makeRepo({ "src/app.ts": "export const value = 1;\n" });
    try {
        commit(dir);
        saveReadyReceipt(dir, "0".repeat(40));
        const report = assessReadiness(dir);
        const receipt = report.checks.find((check) => check.id === "receipt");
        assert.ok(receipt);
        assert.notEqual(receipt.status, "pass");
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("assessReadiness verifies a signed receipt when a public key is committed", () => {
    const dir = makeRepo({ "src/app.ts": "export const value = 1;\n" });
    try {
        const sha = commit(dir);
        const pair = generateReceiptKeyPair();
        saveReceipt(dir, signReceipt({
            version: RECEIPT_VERSION,
            tool: "oc-pilot",
            toolVersion: "0.43.0",
            createdAt: "2026-11-05T00:00:00.000Z",
            commit: sha,
            branch: "main",
            dirty: false,
            diff: { files: 0, additions: 0, deletions: 0 },
            files: [],
            tests: null,
            preflight: PREFLIGHT,
        }, pair.privateKey));
        mkdirSync(join(dir, ".oc-pilot"), { recursive: true });
        writeFileSync(join(dir, ".oc-pilot", "receipt.pub"), pair.publicKey, "utf8");
        const signed = assessReadiness(dir).checks.find((check) => check.id === "receipt");
        assert.equal(signed?.status, "pass");
        assert.match(signed?.detail ?? "", /подпись проверена/);
        const path = join(dir, ".git", "oc-pilot", "receipt.json");
        const stored = JSON.parse(readFileSync(path, "utf8"));
        stored.signature = Buffer.from("broken").toString("base64");
        writeFileSync(path, JSON.stringify(stored), "utf8");
        const tampered = assessReadiness(dir).checks.find((check) => check.id === "receipt");
        assert.notEqual(tampered?.status, "pass");
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("assessReadiness fails on a vulnerable source file", () => {
    const dir = makeRepo({
        "src/app.js": 'const { exec } = require("child_process");\nexec(req.query.cmd);\n',
    });
    try {
        const report = assessReadiness(dir);
        const security = report.checks.find((check) => check.id === "security");
        assert.ok(security);
        assert.equal(security.status, "fail");
        assert.match(security.detail, /1 high/);
        assert.equal(security.points, 0);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("assessReadiness ignores vulnerable test fixtures", () => {
    const dir = makeRepo({
        "src/app.js": "export const ok = 1;\n",
        "src/app.test.js": 'const { exec } = require("child_process");\nexec(req.query.cmd);\n',
    });
    try {
        const security = assessReadiness(dir).checks.find((check) => check.id === "security");
        assert.ok(security);
        assert.equal(security.status, "pass");
        assert.match(security.detail, /опасных паттернов нет/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("assessReadiness honors the findings baseline", () => {
    const source = 'const { exec } = require("child_process");\nexec(req.query.cmd);\n';
    const dir = makeRepo({ "src/app.js": source });
    try {
        const findings = scanSource("src/app.js", source).findings;
        saveFindingsBaseline(dir, ".oc-pilot/baseline.json", {
            version: 1,
            sast: findings.map(sastFingerprint),
            authz: [],
        });
        const security = assessReadiness(dir).checks.find((check) => check.id === "security");
        assert.ok(security);
        assert.equal(security.status, "pass");
        assert.match(security.detail, /опасных паттернов нет/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("renderBadge and renderReadiness describe the score", () => {
    const dir = makeRepo({});
    try {
        const report = assessReadiness(dir);
        assert.match(renderBadge(report), /img\.shields\.io\/badge\/agent/);
        assert.match(renderBadge(report), new RegExp(`${String(report.score)}%2F100`));
        const text = renderReadiness(report);
        assert.match(text, /Готовность к агенту:/);
        assert.match(text, new RegExp(`${String(report.score)}/100`));
        assert.ok(text.endsWith("\n"));
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=readiness.test.js.map