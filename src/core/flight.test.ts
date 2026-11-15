import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  activeFlight,
  appendFlightEvent,
  addFlightNote,
  auditFlights,
  bisectFlight,
  compareFlights,
  compareFlightShows,
  createCheckpoint,
  diffFlight,
  endFlight,
  execInFlight,
  exportFlight,
  flightStats,
  flightStatus,
  loadFlightBundle,
  flightShowFromBundle,
  generateFlightKey,
  listFlights,
  pruneFlights,
  readFlightEvents,
  renderFlightCompareHtml,
  renderFlightHtml,
  renderFlightAudit,
  renderFlightStatsHtml,
  renderFlightSummary,
  replayFlight,
  restoreFlight,
  type FlightStats,
  showFlight,
  signFlightBundle,
  startFlight,
  verifyFlightBundle,
  verifyFlightEvents,
} from "./flight.js";

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function makeRepo(): string {
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
  } finally {
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
  } finally {
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
  } finally {
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
  } finally {
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

    const failed = execInFlight(
      dir,
      [process.execPath, "-e", "process.exit(3)"],
      { quiet: true },
    );
    assert.equal(failed.exitCode, 3);
  } finally {
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readFlightEvents rejects malformed JSONL", () => {
  const dir = makeRepo();
  try {
    const session = startFlight(dir, "broken");
    writeFileSync(join(session.dir, "events.jsonl"), "{not json}\n", "utf8");
    assert.throws(() => readFlightEvents(session.dir), /Повреждён журнал/);
  } finally {
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
    } finally {
      git(["worktree", "remove", "--force", result.path], dir);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restoreFlight restores a checkpoint and refuses a dirty tree", () => {
  const dir = makeRepo();
  try {
    startFlight(dir, "restore");
    writeFileSync(join(dir, "b.txt"), "two\n", "utf8");
    createCheckpoint(dir, "after-b");
    endFlight(dir);

    writeFileSync(join(dir, "a.txt"), "changed\n", "utf8");
    writeFileSync(join(dir, "c.txt"), "keep\n", "utf8");
    const dry = restoreFlight(dir, "after-b", undefined, false, true);
    assert.equal(dry.dryRun, true);
    assert.ok(dry.files.includes("a.txt"));
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "changed\n");
    assert.throws(() => restoreFlight(dir, "after-b"), /Рабочее дерево содержит изменения/);

    const result = restoreFlight(dir, "after-b", undefined, true);
    assert.equal(result.label, "after-b");
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "one\n");
    assert.equal(readFileSync(join(dir, "b.txt"), "utf8"), "two\n");
    assert.equal(readFileSync(join(dir, "c.txt"), "utf8"), "keep\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auditFlights reports tampered sessions", () => {
  const dir = makeRepo();
  try {
    startFlight(dir, "clean");
    endFlight(dir);
    const broken = startFlight(dir, "broken");
    endFlight(dir);

    const events = readFlightEvents(broken.dir);
    const tampered = structuredClone(events);
    const first = tampered[0];
    assert.ok(first);
    first.payload = { ...(first.payload as Record<string, unknown>), injected: true };
    writeFileSync(
      join(broken.dir, "events.jsonl"),
      `${tampered.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    );

    const audit = auditFlights(dir);
    assert.equal(audit.total, 2);
    assert.equal(audit.valid, 1);
    assert.equal(audit.tampered, 1);
    const bad = audit.flights.find((flight) => flight.id === broken.meta.id);
    assert.equal(bad?.valid, false);
    assert.ok((bad?.errors.length ?? 0) > 0);
    assert.match(renderFlightAudit(audit), /FLIGHT AUDIT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("showFlight defaults to the latest flight and exits 2 on an empty journal", () => {
  const dir = makeRepo();
  try {
    assert.throws(
      () => showFlight(dir),
      (error: unknown) => (error as { exitCode?: number }).exitCode === 2,
    );
    const session = startFlight(dir, "default");
    endFlight(dir);
    assert.equal(showFlight(dir).meta.id, session.meta.id);
    assert.throws(
      () => showFlight(dir, "no-such-flight"),
      (error: unknown) => (error as { exitCode?: number }).exitCode === 2,
    );
  } finally {
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
  } finally {
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
    const script =
      "const fs=require('fs');process.exit(fs.readFileSync('a.txt','utf8').includes('bad')?1:0)";
    const result = bisectFlight(dir, undefined, [process.execPath, "-e", script], 60_000);
    assert.equal(result.steps.length, 2);
    assert.equal(result.firstBad?.label, "bad");
    assert.equal(result.firstBad?.exitCode, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderFlightSummary lists checkpoints and commands", () => {
  const dir = makeRepo();
  try {
    const session = startFlight(dir, "summary");
    execInFlight(dir, [process.execPath, "-e", "process.exit(0)"], { quiet: true });
    addFlightNote(dir, "почему так");
    createCheckpoint(dir, "cp-one");
    endFlight(dir);
    const markdown = renderFlightSummary(showFlight(dir, session.meta.id));
    assert.match(markdown, /^# Полёт: summary/);
    assert.match(markdown, /\| cp-one \|/);
    assert.match(markdown, /## Команды/);
    assert.match(markdown, /## Заметки/);
    assert.match(markdown, /- почему так/);
    assert.match(markdown, /Цепочка: целая/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderFlightCompareHtml escapes names and shows differences", () => {
  const side = (id: string, name: string) => ({
    id,
    name,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1000,
    events: 2,
    commands: 1,
    checkpoints: 1,
    failedCommands: 0,
    valid: true,
    baseCommit: "abc",
  });
  const html = renderFlightCompareHtml({
    a: side("a", "<script>alert(1)</script>"),
    b: side("b", "B"),
    common: [["npm", "test"]],
    onlyA: [["node", "-e", "x"]],
    onlyB: [],
    exitCodeDifferences: [{ command: ["npm", "test"], a: 0, b: 1 }],
    sameFinalTree: false,
  });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /Exit code differences/);
  assert.match(html, /different tree/);
});

test("compareFlights reports command differences and final tree equality", () => {
  const dir = makeRepo();
  try {
    const command = [
      process.execPath,
      "-e",
      "process.exit(require('fs').readFileSync('a.txt','utf8').includes('bad')?1:0)",
    ];
    const first = startFlight(dir, "first");
    execInFlight(dir, command, { quiet: true });
    createCheckpoint(dir, "first-green");
    endFlight(dir);

    writeFileSync(join(dir, "a.txt"), "bad\n", "utf8");
    const second = startFlight(dir, "second");
    execInFlight(dir, command, { quiet: true });
    createCheckpoint(dir, "second-red");
    endFlight(dir);

    const result = compareFlights(dir, first.meta.id, second.meta.id);
    assert.equal(result.a.commands, 1);
    assert.equal(result.b.commands, 1);
    assert.equal(result.a.checkpoints, 1);
    assert.equal(result.b.checkpoints, 1);
    assert.equal(result.a.failedCommands, 0);
    assert.equal(result.b.failedCommands, 1);
    assert.equal(result.common.length, 1);
    assert.deepEqual(result.onlyA, []);
    assert.deepEqual(result.onlyB, []);
    assert.equal(result.exitCodeDifferences.length, 1);
    assert.equal(result.exitCodeDifferences[0]?.a, 0);
    assert.equal(result.exitCodeDifferences[0]?.b, 1);
    assert.equal(result.sameFinalTree, false);
    assert.equal(result.a.valid, true);
    assert.equal(result.b.valid, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pruneFlights removes old ended sessions and keeps the active flight", () => {
  const dir = makeRepo();
  try {
    startFlight(dir, "first");
    endFlight(dir);
    startFlight(dir, "second");
    endFlight(dir);
    const active = startFlight(dir, "active");

    const dry = pruneFlights(dir, { keep: 0, dryRun: true });
    assert.equal(dry.removed.length, 2);
    assert.equal(dry.kept, 1);
    assert.equal(dry.active, active.meta.id);
    assert.equal(dry.dryRun, true);
    assert.equal(listFlights(dir).length, 3);

    const real = pruneFlights(dir, { keep: 0 });
    assert.equal(real.removed.length, 2);
    assert.equal(listFlights(dir).length, 1);
    assert.equal(activeFlight(dir)?.meta.id, active.meta.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addFlightNote appends a hash-chained note", () => {
  const dir = makeRepo();
  try {
    startFlight(dir, "notes");
    const result = addFlightNote(dir, "почему так");
    assert.equal(result.note, "почему так");
    assert.equal(result.seq, 2);
    const show = showFlight(dir, result.id);
    assert.equal(show.verification.valid, true);
    const note = show.events.find((event) => event.kind === "note");
    assert.equal(note?.payload.text, "почему так");
    assert.throws(() => addFlightNote(dir, "   "), /Пустая заметка/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generateFlightKey returns unique 64-character hex keys", () => {
  const first = generateFlightKey();
  const second = generateFlightKey();
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.match(second, /^[0-9a-f]{64}$/);
  assert.notEqual(first, second);
});

test("renderFlightStatsHtml escapes command names", () => {
  const stats: FlightStats = {
    total: 2,
    active: 0,
    ended: 2,
    events: 10,
    commands: 2,
    checkpoints: 2,
    failedCommands: 1,
    durationMs: 1000,
    averageDurationMs: 500,
    topCommands: [{ command: "<script>alert(1)</script>", runs: 2, failures: 1 }],
  };
  const html = renderFlightStatsHtml(stats);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /Top commands/);
  assert.match(html, /Failed commands/);
});

test("flightStats aggregates sessions and commands", () => {
  const dir = makeRepo();
  try {
    const command = [
      process.execPath,
      "-e",
      "process.exit(require('fs').readFileSync('a.txt','utf8').includes('bad')?1:0)",
    ];
    startFlight(dir, "first");
    execInFlight(dir, command, { quiet: true });
    createCheckpoint(dir, "first-cp");
    endFlight(dir);

    writeFileSync(join(dir, "a.txt"), "bad\n", "utf8");
    startFlight(dir, "second");
    execInFlight(dir, command, { quiet: true });
    createCheckpoint(dir, "second-cp");
    endFlight(dir);

    const stats = flightStats(dir);
    assert.equal(stats.total, 2);
    assert.equal(stats.ended, 2);
    assert.equal(stats.active, 0);
    assert.equal(stats.events, 10);
    assert.equal(stats.commands, 2);
    assert.equal(stats.checkpoints, 2);
    assert.equal(stats.failedCommands, 1);
    assert.equal(stats.topCommands.length, 1);
    assert.equal(stats.topCommands[0]?.runs, 2);
    assert.equal(stats.topCommands[0]?.failures, 1);
    assert.ok(stats.durationMs >= 0);
    assert.ok(stats.averageDurationMs >= 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderFlightHtml escapes content and includes checkpoints", () => {
  const dir = makeRepo();
  try {
    const session = startFlight(dir, "<script>alert(1)</script>");
    execInFlight(dir, [process.execPath, "-e", "console.log('<img src=x>')"], { quiet: true });
    writeFileSync(join(dir, "b.txt"), "<b>patch</b>\n", "utf8");
    createCheckpoint(dir, "<b>after</b>");
    endFlight(dir);

    const bundle = exportFlight(dir, session.meta.id);
    const html = renderFlightHtml(bundle);
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
    assert.match(html, /&lt;b&gt;after&lt;\/b&gt;/);
    assert.match(html, /&lt;img src=x&gt;/);
    assert.match(html, /chain valid/);
    assert.match(html, /Timeline/);

    const tampered = {
      ...bundle,
      events: bundle.events.map((event, index) =>
        index === 0
          ? {
              ...event,
              payload: { ...(event.payload as Record<string, unknown>), name: "tampered" },
            }
          : event,
      ),
    };
    const tamperedHtml = renderFlightHtml(tampered);
    assert.match(tamperedHtml, /chain tampered/);
    assert.match(tamperedHtml, /Chain errors/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exportFlight defaults to the most recent flight after end", () => {
  const dir = makeRepo();
  try {
    const session = startFlight(dir, "ended");
    createCheckpoint(dir, "ended-cp");
    endFlight(dir);
    assert.equal(activeFlight(dir), undefined);

    const result = exportFlight(dir);
    assert.equal(result.meta.id, session.meta.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compareFlightShows compares two loaded bundles", () => {
  const dir = makeRepo();
  try {
    const first = startFlight(dir, "bundle-a");
    execInFlight(dir, [process.execPath, "-e", "process.exit(0)"], { quiet: true });
    createCheckpoint(dir, "a-cp");
    endFlight(dir);

    const second = startFlight(dir, "bundle-b");
    execInFlight(dir, [process.execPath, "-e", "process.exit(0)"], { quiet: true });
    createCheckpoint(dir, "b-cp");
    endFlight(dir);

    const aPath = join(dir, "a.json");
    const bPath = join(dir, "b.json");
    writeFileSync(aPath, JSON.stringify(exportFlight(dir, first.meta.id)), "utf8");
    writeFileSync(bPath, JSON.stringify(exportFlight(dir, second.meta.id)), "utf8");

    const result = compareFlightShows(
      flightShowFromBundle(loadFlightBundle(aPath)),
      flightShowFromBundle(loadFlightBundle(bPath)),
    );
    assert.equal(result.a.name, "bundle-a");
    assert.equal(result.b.name, "bundle-b");
    assert.equal(result.a.valid, true);
    assert.equal(result.b.valid, true);
    assert.equal(result.common.length, 1);
    assert.equal(typeof result.sameFinalTree, "boolean");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadFlightBundle reads an exported bundle", () => {
  const dir = makeRepo();
  try {
    const session = startFlight(dir, "portable");
    createCheckpoint(dir, "portable-cp");
    endFlight(dir);
    const bundle = exportFlight(dir, session.meta.id);
    const bundlePath = join(dir, "portable.json");
    writeFileSync(bundlePath, JSON.stringify(bundle, null, 2), "utf8");

    const loaded = loadFlightBundle(bundlePath);
    assert.equal(loaded.meta.id, session.meta.id);
    assert.equal(loaded.digest, bundle.digest);
    assert.equal(loaded.events.length, bundle.events.length);
    assert.equal(loaded.checkpoints.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("flightShowFromBundle recomputes the chain for a loaded bundle", () => {
  const dir = makeRepo();
  try {
    const session = startFlight(dir, "bundle-show");
    createCheckpoint(dir, "bundle-cp");
    endFlight(dir);
    const bundle = exportFlight(dir, session.meta.id);

    const show = flightShowFromBundle(bundle);
    assert.equal(show.meta.id, session.meta.id);
    assert.equal(show.events.length, bundle.events.length);
    assert.equal(show.verification.valid, true);

    const tampered = {
      ...bundle,
      events: bundle.events.map((event, index) =>
        index === 0
          ? { ...event, payload: { ...(event.payload as Record<string, unknown>), name: "tampered" } }
          : event,
      ),
    };
    assert.equal(flightShowFromBundle(tampered).verification.valid, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("signFlightBundle re-signs a valid bundle and refuses a tampered one", () => {
  const dir = makeRepo();
  try {
    const session = startFlight(dir, "resign");
    createCheckpoint(dir, "resign-cp");
    endFlight(dir);

    const keyOne = join(dir, "one.key");
    const keyTwo = join(dir, "two.key");
    writeFileSync(keyOne, "first-secret", "utf8");
    writeFileSync(keyTwo, "second-secret", "utf8");

    const signed = exportFlight(dir, session.meta.id, keyOne);
    const resigned = signFlightBundle(signed, keyTwo);
    const path = join(dir, "resigned.json");
    writeFileSync(path, JSON.stringify(resigned, null, 2), "utf8");
    const verified = verifyFlightBundle(path, keyTwo);
    assert.equal(verified.signature, "valid");
    assert.equal(verified.valid, true);

    const tampered = { ...signed, exportedAt: "2000-01-01T00:00:00.000Z" };
    assert.throws(() => signFlightBundle(tampered, keyTwo), /digest не совпадает/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exportFlight signs a bundle and verifyFlightBundle checks it", () => {
  const dir = makeRepo();
  try {
    const session = startFlight(dir, "signed");
    createCheckpoint(dir, "signed-cp");
    endFlight(dir);

    const keyPath = join(dir, "flight.key");
    writeFileSync(keyPath, "flight-secret", "utf8");
    const bundle = exportFlight(dir, session.meta.id, keyPath);
    assert.equal(bundle.signature?.type, "hmac-sha256");
    const bundlePath = join(dir, "bundle.json");
    writeFileSync(bundlePath, JSON.stringify(bundle, null, 2), "utf8");

    const verified = verifyFlightBundle(bundlePath, keyPath);
    assert.equal(verified.digestOk, true);
    assert.equal(verified.chainOk, true);
    assert.equal(verified.signature, "valid");
    assert.equal(verified.valid, true);
    assert.deepEqual(verified.errors, []);

    const noKey = verifyFlightBundle(bundlePath);
    assert.equal(noKey.signature, "unchecked");
    assert.equal(noKey.valid, false);

    const wrongKeyPath = join(dir, "wrong.key");
    writeFileSync(wrongKeyPath, "wrong-secret", "utf8");
    const wrongKey = verifyFlightBundle(bundlePath, wrongKeyPath);
    assert.equal(wrongKey.signature, "invalid");
    assert.equal(wrongKey.valid, false);

    const tampered = { ...bundle, exportedAt: "2000-01-01T00:00:00.000Z" };
    const tamperedPath = join(dir, "tampered.json");
    writeFileSync(tamperedPath, JSON.stringify(tampered, null, 2), "utf8");
    const tamperedResult = verifyFlightBundle(tamperedPath, keyPath);
    assert.equal(tamperedResult.digestOk, false);
    assert.equal(tamperedResult.valid, false);
  } finally {
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
