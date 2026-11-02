import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runDay } from "./day.js";

function makeRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync("git config user.email test@example.com", { cwd: dir, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
  execSync("git config core.autocrlf false", { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "init\n");
  execSync("git add -A", { cwd: dir, stdio: "ignore" });
  execSync("git commit -m init", { cwd: dir, stdio: "ignore" });
  return dir;
}

test("day summarizes commits, files and totals as json", async () => {
  const dir = makeRepo("oc-pilot-day-");
  const outPath = join(dir, "day.json");
  try {
    writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
    execSync("git add a.txt", { cwd: dir, stdio: "ignore" });
    execSync('git commit -m "add a.txt"', { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, "b.txt"), "three\n");
    execSync("git add b.txt", { cwd: dir, stdio: "ignore" });
    execSync('git commit -m "add b.txt"', { cwd: dir, stdio: "ignore" });

    const code = await runDay(["--cwd", dir, "--json", "--output", outPath]);
    assert.equal(code, 0);

    const payload = JSON.parse(readFileSync(outPath, "utf8")) as {
      commits: Array<{ subject: string }>;
      files: Array<{ file: string }>;
      totals: { commits: number; additions: number };
      ocPilot: { runs: number };
    };
    assert.equal(payload.commits.length, 3);
    assert.ok(payload.commits.some((commit) => commit.subject === "add a.txt"));
    const files = payload.files.map((file) => file.file);
    assert.ok(files.includes("a.txt"));
    assert.ok(files.includes("b.txt"));
    assert.equal(payload.totals.commits, 3);
    assert.ok(payload.totals.additions >= 3);
    assert.equal(typeof payload.ocPilot.runs, "number");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
