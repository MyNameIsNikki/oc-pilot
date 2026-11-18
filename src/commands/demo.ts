import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PilotError } from "../core/errors.js";
import {
  createCheckpoint,
  endFlight,
  proveClaim,
  renderFlightProof,
  startFlight,
} from "../core/flight.js";
import { runGit } from "../core/git.js";
import { writeOutput } from "../core/io.js";
import { COMMON_HELP, parseCommandArgs, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean } from "../core/parse.js";

const OPTIONS: OptionSpec = withCommon({
  keep: { type: "boolean" },
});

const HELP = `Usage:
  oc-pilot demo [options]

Runs a 20-second end-to-end proof in a throwaway git repo: starts a flight,
records a checkpoint that fixes a check, ends the flight, then proves the claim
from the fail-to-pass transition.

Options:
      --keep                keep the temporary repository and print its path
      --json                print the proof as JSON
${COMMON_HELP}

Examples:
  oc-pilot demo
  oc-pilot demo --keep
  oc-pilot demo --json
`;

const CLAIM = "greeting includes world";
const CHECK = [
  process.execPath,
  "-e",
  "process.exit(require('fs').readFileSync('greeting.txt','utf8').includes('world')?0:1)",
];

function git(cwd: string, args: string[]): void {
  const result = runGit(args, cwd);
  if (result.status !== 0) {
    throw new PilotError(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`, {
      hint: "Install git and make sure it is available on PATH.",
    });
  }
}

function initRepo(dir: string): void {
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "demo@oc-pilot.dev"]);
  git(dir, ["config", "user.name", "oc-pilot demo"]);
  writeFileSync(join(dir, "greeting.txt"), "hello\n", "utf8");
  git(dir, ["add", "greeting.txt"]);
  git(dir, ["commit", "-qm", "hello"]);
}

export function runDemo(argv: string[]): number {
  const { values } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const keep = asBoolean(values, "keep");
  const json = asBoolean(values, "json");
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-demo-"));

  try {
    initRepo(dir);
    startFlight(dir, "demo");
    writeFileSync(join(dir, "greeting.txt"), "hello world\n", "utf8");
    createCheckpoint(dir, "adds world");
    endFlight(dir);

    const proof = proveClaim(dir, CLAIM, CHECK, undefined, 120_000);
    if (json) {
      writeOutput(JSON.stringify(proof, null, 2));
    } else {
      process.stdout.write("oc-pilot demo\n\n");
      process.stdout.write(`repo:  ${dir}\n`);
      process.stdout.write(`claim: ${CLAIM}\n\n`);
      process.stdout.write(`${renderFlightProof(proof)}\n`);
      process.stdout.write(
        proof.verdict === "proven"
          ? "\nPROVEN: the claim is backed by a fail-to-pass transition.\n"
          : "\nThe demo did not prove the claim, which means something is wrong in oc-pilot.\n",
      );
    }
    return proof.verdict === "proven" ? 0 : 2;
  } finally {
    if (keep) {
      process.stdout.write(`kept: ${dir}\n`);
    } else {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
