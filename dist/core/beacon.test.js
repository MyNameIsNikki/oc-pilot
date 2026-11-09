import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { beaconPath, clearBeacon, createBeacon, parseBeaconCheck, readBeacon, renderBeacon, renderBeaconMarkdown, verifyBeacon, } from "./beacon.js";
function git(args, cwd) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0)
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout;
}
function makeRepo() {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-beacon-"));
    git(["init", "-q"], dir);
    git(["config", "user.email", "test@example.com"], dir);
    git(["config", "user.name", "Test"], dir);
    git(["config", "core.autocrlf", "false"], dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "app.ts"), "export const value = 1;\n", "utf8");
    git(["add", "."], dir);
    git(["commit", "-m", "init"], dir);
    return dir;
}
test("parseBeaconCheck accepts name=status and rejects malformed checks", () => {
    assert.deepEqual(parseBeaconCheck("tests=pass"), { name: "tests", status: "pass" });
    assert.deepEqual(parseBeaconCheck("unit tests=warn"), { name: "unit tests", status: "warn" });
    assert.throws(() => parseBeaconCheck("tests"), /Некорректная проверка/);
    assert.throws(() => parseBeaconCheck("tests=maybe"), /Некорректная проверка/);
});
test("createBeacon writes an unsigned manifest and verify marks it unattributed", () => {
    const dir = makeRepo();
    try {
        const manifest = createBeacon(dir, {
            checks: [
                { name: "tests", status: "pass" },
                { name: "preflight", status: "pass" },
            ],
            agent: "claude-code",
            model: "opus-4",
            commands: ["npm test"],
        });
        assert.equal(manifest.verdict, "pass");
        assert.match(manifest.digest, /^sha256:/);
        assert.equal(manifest.signature, undefined);
        assert.equal(readBeacon(dir)?.digest, manifest.digest);
        const verified = verifyBeacon(dir);
        assert.equal(verified.status, "unsigned");
        assert.match(verified.summary, /\[UNATTRIBUTED\]/);
        assert.match(renderBeacon(manifest), /Checks: tests=pass, preflight=pass/);
        assert.match(renderBeaconMarkdown(manifest), /## oc-pilot beacon/);
        assert.match(renderBeaconMarkdown(manifest), /UNATTRIBUTED/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("createBeacon signs with HMAC and verify accepts the right key", () => {
    const dir = makeRepo();
    const key = join(dir, "beacon.key");
    try {
        writeFileSync(key, "correct horse battery staple\n", "utf8");
        const manifest = createBeacon(dir, {
            checks: [{ name: "tests", status: "pass" }],
            keyPath: key,
        });
        assert.equal(manifest.signature?.type, "hmac-sha256");
        const valid = verifyBeacon(dir, { keyPath: key });
        assert.equal(valid.status, "valid", valid.summary);
        assert.match(valid.summary, /\[BEACON VALID\]/);
        writeFileSync(key, "wrong key\n", "utf8");
        const wrong = verifyBeacon(dir, { keyPath: key });
        assert.equal(wrong.status, "unattributed");
        assert.match(wrong.summary, /\[UNATTRIBUTED\]/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("verifyBeacon detects a tampered manifest", () => {
    const dir = makeRepo();
    try {
        createBeacon(dir, { checks: [{ name: "tests", status: "pass" }] });
        const manifest = JSON.parse(readFileSync(beaconPath(dir), "utf8"));
        manifest.agent = "someone-else";
        writeFileSync(beaconPath(dir), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
        const result = verifyBeacon(dir);
        assert.equal(result.status, "tampered");
        assert.match(result.summary, /\[BEACON TAMPERED\]/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("beacon verdict fails on a failed check and clearBeacon removes the file", () => {
    const dir = makeRepo();
    try {
        const manifest = createBeacon(dir, {
            checks: [
                { name: "tests", status: "pass" },
                { name: "sast", status: "fail" },
            ],
        });
        assert.equal(manifest.verdict, "fail");
        assert.equal(clearBeacon(dir).removed, true);
        assert.equal(clearBeacon(dir).removed, false);
        assert.equal(verifyBeacon(dir).status, "missing");
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=beacon.test.js.map