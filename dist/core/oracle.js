import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runShellCommand } from "./command.js";
import { PilotError } from "./errors.js";
import { runGit } from "./git.js";
import { createShadow, writeShadowDiff } from "./shadow.js";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_CASES = 50;
const MAX_CASES = 200;
const MAX_OUTPUT = 4_000;
function cap(value, limit) {
    return value.length > limit ? value.slice(0, limit) : value;
}
/** Parses an array of cases, a {cases:[...]} object or a single case object. */
export function parseOracleCorpus(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return undefined;
    }
    let list;
    if (Array.isArray(parsed))
        list = parsed;
    else if (parsed && typeof parsed === "object" && Array.isArray(parsed.cases)) {
        list = parsed.cases;
    }
    else if (parsed && typeof parsed === "object" && "input" in parsed) {
        list = [parsed];
    }
    else {
        return undefined;
    }
    const cases = [];
    for (const [index, item] of list.entries()) {
        if (cases.length >= MAX_CASES)
            break;
        if (item && typeof item === "object" && !Array.isArray(item) && "input" in item) {
            const record = item;
            const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : `case-${String(index + 1)}`;
            cases.push({ id, input: record.input });
        }
        else {
            cases.push({ id: `case-${String(index + 1)}`, input: item });
        }
    }
    return cases;
}
function normalizeOutput(output) {
    return output.replace(/\r\n/g, "\n").trimEnd();
}
function commandFor(command, inputPath) {
    return command.split("{input}").join(`"${inputPath}"`);
}
async function runCase(command, cwd, timeoutMs) {
    const result = await runShellCommand(command, cwd, { timeoutMs, maxBufferChars: 1_000_000 });
    return {
        exitCode: result.exitCode,
        output: cap(normalizeOutput(result.output), MAX_OUTPUT),
        timedOut: result.timedOut,
    };
}
function difference(before, after) {
    if (before.timedOut !== after.timedOut)
        return "timeout";
    if (before.exitCode !== after.exitCode)
        return "exit code";
    if (before.output !== after.output)
        return "output";
    return undefined;
}
/** Runs the same corpus on clean HEAD and on the diff, then compares the results. */
export async function runOracle(cwd, diff, cases, options) {
    if (!options.command.includes("{input}")) {
        throw new PilotError("Команда oracle должна содержать {input}", {
            hint: "Пример: --command \"node harness.mjs {input}\".",
            exitCode: 2,
        });
    }
    const timeoutMs = Math.max(1_000, Math.min(MAX_TIMEOUT_MS, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    const maxCases = Math.max(1, Math.min(MAX_CASES, options.maxCases ?? DEFAULT_MAX_CASES));
    const selected = cases.slice(0, maxCases);
    const patch = writeShadowDiff(diff);
    const head = createShadow(cwd, "oracle-head");
    const changedTree = createShadow(cwd, "oracle-diff");
    const inputDir = mkdtempSync(join(tmpdir(), "oc-pilot-oracle-"));
    try {
        const check = runGit(["apply", "--check", patch.path], changedTree.dir);
        if (check.status !== 0) {
            throw new PilotError("Diff не применился в shadow worktree", {
                hint: check.stderr.trim() || check.stdout.trim() || undefined,
                exitCode: 2,
            });
        }
        const applied = runGit(["apply", patch.path], changedTree.dir);
        if (applied.status !== 0) {
            throw new PilotError("Не удалось применить diff в shadow worktree", {
                hint: applied.stderr.trim() || applied.stdout.trim() || undefined,
                exitCode: 2,
            });
        }
        const results = [];
        for (const [index, item] of selected.entries()) {
            const inputPath = join(inputDir, `case-${String(index + 1)}.json`);
            writeFileSync(inputPath, JSON.stringify(item.input), "utf8");
            const command = commandFor(options.command, inputPath);
            const before = await runCase(command, head.dir, timeoutMs);
            const after = await runCase(command, changedTree.dir, timeoutMs);
            const reason = difference(before, after);
            results.push({
                id: item.id,
                input: item.input,
                before,
                after,
                changed: reason !== undefined,
                reason,
            });
        }
        const changed = results.filter((result) => result.changed).length;
        const status = changed > 0 ? "changed" : "same";
        const summary = results.length === 0
            ? "[BEHAVIOR SAME]: кейсов нет, сравнивать нечего."
            : status === "changed"
                ? `[BEHAVIOR CHANGED]: ${String(changed)} из ${String(results.length)} кейсов дали другой результат.`
                : `[BEHAVIOR SAME]: все ${String(results.length)} кейсов совпали на HEAD и diff.`;
        const report = {
            source: options.source ?? "diff",
            command: options.command,
            cases: results.length,
            changed,
            status,
            results,
            summary,
            content: "",
        };
        report.content = renderOracle(report);
        return report;
    }
    finally {
        head.cleanup();
        changedTree.cleanup();
        patch.cleanup();
        rmSync(inputDir, { recursive: true, force: true });
    }
}
export function renderOracle(report) {
    const lines = [
        `Oracle: ${report.status}`,
        `Source: ${report.source}`,
        `Command: ${report.command}`,
        `Cases: ${String(report.cases)}, changed ${String(report.changed)}`,
    ];
    const shown = report.results.filter((result) => result.changed).slice(0, 20);
    for (const result of shown) {
        lines.push(`  [CHANGED] ${result.id} (${result.reason ?? "output"})`);
        lines.push(`    input:  ${cap(JSON.stringify(result.input), 300)}`);
        lines.push(`    before: exit ${String(result.before.exitCode)}${result.before.timedOut ? " (timeout)" : ""}, ${cap(result.before.output, 500)}`);
        lines.push(`    after:  exit ${String(result.after.exitCode)}${result.after.timedOut ? " (timeout)" : ""}, ${cap(result.after.output, 500)}`);
    }
    if (report.changed > shown.length)
        lines.push(`  ... ещё ${String(report.changed - shown.length)}`);
    if (report.changed === 0)
        lines.push("  Все кейсы совпали.");
    lines.push("", report.summary);
    return `${lines.join("\n")}\n`;
}
//# sourceMappingURL=oracle.js.map