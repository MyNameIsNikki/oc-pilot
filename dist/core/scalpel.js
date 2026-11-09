import { collectChangedFiles } from "./diff.js";
import { PilotError } from "./errors.js";
import { runShellCommand } from "./command.js";
import { runGit } from "./git.js";
import { analyzeImpact } from "./impact.js";
import { detectTestCommand } from "./project.js";
import { createShadow, writeShadowDiff } from "./shadow.js";
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_OUTPUT = 5_000;
function cap(output) {
    return output.length > MAX_OUTPUT ? output.slice(-MAX_OUTPUT) : output;
}
export function parseScalpelHypothesis(text) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start)
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(text.slice(start, end + 1));
    }
    catch {
        return undefined;
    }
    if (!parsed || typeof parsed !== "object")
        return undefined;
    const record = parsed;
    const patch = typeof record.patch === "string" ? record.patch.trim() : "";
    const reason = typeof record.reason === "string" ? record.reason.trim() : "";
    if (!reason)
        return undefined;
    return { patch, reason };
}
export function buildScalpelPrompt(failure, currentDiff, context) {
    const cappedFailure = failure.length > 40_000 ? failure.slice(-40_000) : failure;
    const cappedDiff = currentDiff.length > 60_000 ? currentDiff.slice(0, 60_000) : currentDiff;
    return [
        "You are a surgeon. A test is failing, and the current diff is already applied on top of HEAD.",
        "Produce the smallest unified diff that fixes the failure and applies on top of the current worktree.",
        "Rules: no new dependencies, no deleting or skipping tests, no unrelated refactors, keep the public API unless the fix requires it, touch as few files as possible.",
        "Return strict JSON only, with no markdown and no prose outside the object:",
        '{"patch":"diff --git a/src/x.ts b/src/x.ts\\n...","reason":"why this is the minimal fix"}',
        "If you cannot fix it minimally, return an empty patch and explain why.",
        context ? `Extra context from the author:\n${context}` : "",
        "",
        "FAILURE:",
        cappedFailure,
        "",
        "CURRENT DIFF:",
        cappedDiff,
    ]
        .filter((line) => line.length > 0)
        .join("\n");
}
function applyPatch(dir, patch, label) {
    const temp = writeShadowDiff(patch);
    try {
        const check = runGit(["apply", "--check", temp.path], dir);
        if (check.status !== 0) {
            throw new PilotError(`${label}: патч не применился`, {
                hint: check.stderr.trim() || check.stdout.trim() || undefined,
                exitCode: 2,
            });
        }
        const applied = runGit(["apply", temp.path], dir);
        if (applied.status !== 0) {
            throw new PilotError(`${label}: не удалось применить патч`, {
                hint: applied.stderr.trim() || applied.stdout.trim() || undefined,
                exitCode: 2,
            });
        }
    }
    finally {
        temp.cleanup();
    }
}
/** Applies the current diff plus the proposed fix in a shadow worktree and runs tests. */
export async function verifyScalpel(cwd, currentDiff, hypothesis, options = {}) {
    const files = collectChangedFiles(hypothesis.patch).filter((path) => path !== "(unknown)" && path !== "(diff)");
    if (!hypothesis.patch) {
        return {
            status: "rejected",
            reason: hypothesis.reason,
            patch: "",
            files,
            tests: "skipped",
            summary: "[SCALPEL REJECTED]: модель не предложила патч.",
            content: "",
        };
    }
    const runTests = options.runTests !== false;
    const testCommand = options.testCommand?.trim() || detectTestCommand(cwd)?.command;
    if (runTests && !testCommand) {
        return {
            status: "unverified",
            reason: hypothesis.reason,
            patch: hypothesis.patch,
            files,
            tests: "skipped",
            summary: "[SCALPEL UNVERIFIED]: не удалось определить тестовую команду.",
            content: "",
        };
    }
    const timeoutMs = Math.max(1_000, Math.min(900_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    const shadow = createShadow(cwd, "scalpel", "HEAD");
    try {
        if (currentDiff.trim())
            applyPatch(shadow.dir, currentDiff, "Текущий diff");
        applyPatch(shadow.dir, hypothesis.patch, "Патч scalpel");
        let tests = "skipped";
        let testOutput;
        if (runTests && testCommand) {
            const run = await runShellCommand(testCommand, shadow.dir, { timeoutMs });
            tests = run.exitCode === 0 && !run.timedOut ? "pass" : "fail";
            testOutput = cap(run.output);
        }
        const status = tests === "pass" ? "fixed" : tests === "fail" ? "rejected" : "unverified";
        const summary = status === "fixed"
            ? "[SCALPEL FIXED]: минимальный патч применён, тесты проходят."
            : status === "rejected"
                ? "[SCALPEL REJECTED]: патч не чинит тесты."
                : "[SCALPEL UNVERIFIED]: патч применён, но тесты не запускались.";
        const impact = analyzeImpact(cwd, hypothesis.patch, files);
        const report = {
            status,
            reason: hypothesis.reason,
            patch: hypothesis.patch,
            files,
            tests,
            testOutput,
            impact,
            summary,
            content: "",
        };
        report.content = renderScalpel(report);
        return report;
    }
    finally {
        shadow.cleanup();
    }
}
export function renderScalpel(report) {
    const lines = [
        `Scalpel: ${report.status}`,
        `Reason: ${report.reason}`,
        `Files: ${String(report.files.length)}`,
        ...report.files.map((file) => `  ${file}`),
        `Tests: ${report.tests}`,
    ];
    if (report.testOutput)
        lines.push("Output:", report.testOutput.trimEnd());
    if (report.impact) {
        lines.push(`Blast radius: ${String(report.impact.symbols.length)} symbol(s), ${String(report.impact.references.length)} reference(s)`);
        for (const reference of report.impact.references.slice(0, 10)) {
            lines.push(`  ${reference.symbol} -> ${reference.file}:${String(reference.line)}`);
        }
    }
    lines.push("", report.summary);
    return `${lines.join("\n")}\n`;
}
//# sourceMappingURL=scalpel.js.map