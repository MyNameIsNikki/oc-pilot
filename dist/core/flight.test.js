import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { activeFlight, appendFlightEvent, bisectFlight, createCheckpoint, diffFlight, endFlight, execInFlight, exportFlight, flightStatus, listFlights, readFlightEvents, replayFlight, showFlight, startFlight, verifyFlightEvents, } from "./flight.js";
function git(args, cwd) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}
function makeRepo() {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-flight-"));
    git(["init", "-q"], dir);
    git(["config", "user.email", "test@example.com"], dir);
    git(["config", "user.name", "Test"], dir);
    git(["config", "core.autocrlf", "false"], dir);
    writeFileSync(join(dir, "a.txt"), "one\n", "utf8");
    git(["add", "a.txt"], dir);
    git(["commit", "-qm", "init"], dir);
    return dir;
}
test("startFlight creates a hash-chained session and active status", () => {
    const dir = makeRepo();
    try {
        const session = startFlight(dir, "test flight");
        assert.equal(session.meta.name, "test flight");
        assert.equal(session.events.length, 1);
        assert.equal(session.events[0]?.kind, "session.start");
        assert.equal(session.events[0]?.prev, "genesis");
        assert.match(session.events[0]?.hash ?? "", /^sha256:[0-9a-f]{64}$/);
        assert.equal(verifyFlightEvents(session.events).valid, true);
        const active = activeFlight(dir);
        assert.equal(active?.meta.id, session.meta.id);
        const status = flightStatus(dir);
        assert.equal(status.active, true);
        assert.equal(status.session?.meta.id, session.meta.id);
        assert.equal(status.checkpoints, 0);
        const flights = listFlights(dir);
        assert.equal(flights.length, 1);
        assert.equal(flights[0]?.id, session.meta.id);
        assert.equal(flights[0]?.ended, false);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("verifyFlightEvents detects a modified event", () => {
    const dir = makeRepo();
    try {
        const session = startFlight(dir, "tamper");
        appendFlightEvent(session.dir, "gate.result", { gate: "tests", status: "pass" });
        const events = readFlightEvents(session.dir);
        assert.equal(verifyFlightEvents(events).valid, true);
        const tampered = structuredClone(events);
        const target = tampered[1];
        assert.ok(target);
        target.payload.status = "fail";
        const result = verifyFlightEvents(tampered);
        assert.equal(result.valid, false);
        assert.ok(result.errors.some((error) => error.includes("хеш")));
        const file = join(session.dir, "events.jsonl");
        writeFileSync(file, `${tampered.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
        const shown = showFlight(dir, session.meta.id);
        assert.equal(shown.verification.valid, false);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("createCheckpoint creates a dangling commit without moving HEAD", () => {
    const dir = makeRepo();
    try {
        const before = git(["rev-parse", "HEAD"], dir);
        const session = startFlight(dir, "checkpoint");
        writeFileSync(join(dir, "a.txt"), "two\n", "utf8");
        writeFileSync(join(dir, "b.txt"), "untracked\n", "utf8");
        const checkpoint = createCheckpoint(dir, "after edit");
        assert.match(checkpoint.commit, /^[0-9a-f]{40}$/);
        assert.match(checkpoint.tree, /^[0-9a-f]{40}$/);
        assert.equal(git(["rev-parse", "HEAD"], dir), before);
        assert.equal(git(["cat-file", "-t", checkpoint.commit], dir), "commit");
        assert.equal(git(["show", `${checkpoint.commit}:a.txt`], dir), "two");
        assert.equal(git(["show", `${checkpoint.commit}:b.txt`], dir), "untracked");
        const events = readFlightEvents(session.dir);
        const saved = events.find((event) => event.kind === "file.checkpoint");
        assert.equal(saved?.payload.label, "after edit");
        assert.equal(saved?.payload.commit, checkpoint.commit);
        assert.equal(verifyFlightEvents(events).valid, true);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("endFlight appends session.end and clears the active pointer", () => {
    const dir = makeRepo();
    try {
        const session = startFlight(dir, "finish");
        const result = endFlight(dir);
        assert.equal(result.meta.id, session.meta.id);
        assert.equal(result.events.at(-1)?.kind, "session.end");
        assert.equal(result.summary.checkpoints, 0);
        assert.equal(activeFlight(dir), undefined);
        assert.equal(flightStatus(dir).active, false);
        assert.equal(listFlights(dir)[0]?.ended, true);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("execInFlight records command output and exit code", () => {
    const dir = makeRepo();
    try {
        const session = startFlight(dir, "exec");
        const result = execInFlight(dir, [process.execPath, "-e", "console.log('flight-ok')"], {
            quiet: true,
        });
        assert.equal(result.exitCode, 0);
        assert.match(result.stdoutTail, /flight-ok/);
        const events = readFlightEvents(session.dir);
        assert.equal(events.filter((event) => event.kind === "command.start").length, 1);
        assert.equal(events.filter((event) => event.kind === "command.end").length, 1);
        assert.equal(verifyFlightEvents(events).valid, true);
        const failed = execInFlight(dir, [process.execPath, "-e", "process.exit(3)"], { quiet: true });
        assert.equal(failed.exitCode, 3);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("startFlight refuses a second active flight", () => {
    const dir = makeRepo();
    try {
        startFlight(dir, "first");
        assert.throws(() => startFlight(dir, "second"), /Уже идёт полёт/);
        endFlight(dir);
        const second = startFlight(dir, "second");
        assert.equal(second.meta.name, "second");
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("readFlightEvents rejects malformed JSONL", () => {
    const dir = makeRepo();
    try {
        const session = startFlight(dir, "broken");
        writeFileSync(join(session.dir, "events.jsonl"), "{not json}\n", "utf8");
        assert.throws(() => readFlightEvents(session.dir), /Повреждён журнал/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("replayFlight materializes a checkpoint in a shadow worktree", () => {
    const dir = makeRepo();
    try {
        startFlight(dir, "replay");
        writeFileSync(join(dir, "b.txt"), "two\n", "utf8");
        const checkpoint = createCheckpoint(dir, "after-b");
        const result = replayFlight(dir, undefined, "after-b");
        try {
            assert.equal(result.label, "after-b");
            assert.equal(result.commit, checkpoint.commit);
            assert.equal(readFileSync(join(result.path, "b.txt"), "utf8"), "two\n");
            assert.equal(git(["rev-parse", "HEAD"], result.path), checkpoint.commit);
        }
        finally {
            git(["worktree", "remove", "--force", result.path], dir);
        }
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("diffFlight compares the base commit with a checkpoint", () => {
    const dir = makeRepo();
    try {
        startFlight(dir, "diff");
        writeFileSync(join(dir, "b.txt"), "two\n", "utf8");
        createCheckpoint(dir, "after-b");
        const result = diffFlight(dir);
        assert.equal(result.from.label, "base");
        assert.equal(result.to.label, "after-b");
        assert.match(result.stat, /b\.txt/);
        assert.match(result.patch, /\+two/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("bisectFlight finds the first failing checkpoint", () => {
    const dir = makeRepo();
    try {
        startFlight(dir, "bisect");
        writeFileSync(join(dir, "a.txt"), "good\n", "utf8");
        createCheckpoint(dir, "good");
        writeFileSync(join(dir, "a.txt"), "bad\n", "utf8");
        createCheckpoint(dir, "bad");
        writeFileSync(join(dir, "a.txt"), "bad\n", "utf8");
        createCheckpoint(dir, "worse");
        const script = "const fs=require('fs');process.exit(fs.readFileSync('a.txt','utf8').includes('bad')?1:0)";
        const result = bisectFlight(dir, undefined, [process.execPath, "-e", script], 60_000);
        assert.equal(result.steps.length, 2);
        assert.equal(result.firstBad?.label, "bad");
        assert.equal(result.firstBad?.exitCode, 1);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("exportFlight redacts secrets and includes a digest", () => {
    const dir = makeRepo();
    try {
        startFlight(dir, "export");
        writeFileSync(join(dir, "secret.txt"), "token=abcdefgh12345\n", "utf8");
        createCheckpoint(dir, "with-secret");
        const result = exportFlight(dir);
        assert.equal(result.format, "oc-pilot-flight-export/v1");
        assert.equal(result.meta.id, activeFlight(dir)?.meta.id);
        assert.equal(result.checkpoints.length, 1);
        assert.match(result.digest, /^sha256:[0-9a-f]{64}$/);
        assert.equal(JSON.stringify(result).includes("abcdefgh12345"), false);
        assert.match(JSON.stringify(result), /\[REDACTED\]/);
        assert.equal(result.verification.valid, true);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=flight.test.js.map