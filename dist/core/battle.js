import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
function defaultRunner(args, cwd) {
    const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
        cwd,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 15 * 60 * 1000,
    });
    let json = null;
    try {
        const parsed = JSON.parse(result.stdout ?? "");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            json = parsed;
    }
    catch {
        json = null;
    }
    return { exitCode: result.status ?? 1, json, stderr: result.stderr ?? "" };
}
function sourceArgs(options, diffPath) {
    if (diffPath)
        return ["--diff", diffPath];
    const args = [];
    if (options.base)
        args.push("--base", options.base);
    if (options.staged)
        args.push("--staged");
    if (options.unstaged)
        args.push("--unstaged");
    if (options.includeUntracked)
        args.push("--include-untracked");
    return args;
}
function modelArgs(options) {
    const args = [];
    if (options.model)
        args.push("--model", options.model);
    if (options.lang)
        args.push("--lang", options.lang);
    if (options.timeout)
        args.push("--timeout", String(options.timeout));
    return args;
}
function asObject(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
function findingsFrom(value, source) {
    if (!value || !Array.isArray(value.findings))
        return [];
    const findings = [];
    for (const raw of value.findings) {
        const item = asObject(raw);
        if (!item)
            continue;
        const severity = typeof item.severity === "string" ? item.severity : "warning";
        const text = (typeof item.text === "string" && item.text) ||
            (typeof item.message === "string" && item.message) ||
            (typeof item.rule === "string" && item.rule) ||
            "finding";
        const location = (typeof item.location === "string" && item.location) ||
            (typeof item.file === "string" && item.file) ||
            undefined;
        findings.push({ source, severity, text, ...(location ? { location } : {}) });
    }
    return findings;
}
function isHigh(finding) {
    const severity = finding.severity.toLowerCase();
    return severity === "critical" || severity === "high";
}
function testResult(value) {
    const tests = asObject(value?.tests);
    if (!tests)
        return null;
    const exitCode = typeof tests.exitCode === "number" ? tests.exitCode : null;
    return { passed: exitCode === 0 && tests.timedOut !== true, exitCode };
}
function describeFindings(findings) {
    if (findings.length === 0)
        return "находок нет";
    return findings
        .slice(0, 8)
        .map((finding) => `[${finding.source}/${finding.severity}] ${finding.location ?? ""} ${finding.text}`.trim())
        .join("; ");
}
/** Runs one coder attempt and then attacks the resulting patch with review and offline scanners. */
export function runBattle(cwd, options) {
    const rounds = Math.min(5, Math.max(1, options.rounds ?? 2));
    const apply = options.apply === true;
    const runner = options.runner ?? defaultRunner;
    const tempDir = mkdtempSync(join(tmpdir(), "oc-pilot-battle-"));
    const diffPath = options.diff ? join(tempDir, "input.diff") : undefined;
    if (diffPath && options.diff)
        writeFileSync(diffPath, options.diff, "utf8");
    const patchPath = join(tempDir, "patch.diff");
    const result = { task: options.task, rounds: [], status: "stopped", applied: apply, reason: "" };
    try {
        let previousFindings = [];
        for (let round = 1; round <= rounds; round += 1) {
            const context = [
                `BATTLE_CODER: ${options.task}`,
                options.context ?? "",
                previousFindings.length > 0
                    ? `The hacker found these problems in the previous attempt. Fix them without hiding them:\n${describeFindings(previousFindings)}`
                    : "",
            ]
                .filter(Boolean)
                .join("\n\n");
            const coderArgs = [
                "fix",
                "--json",
                ...(apply && round > 1 ? [] : sourceArgs(options, diffPath)),
                "--context",
                context,
                ...modelArgs(options),
            ];
            if (options.command)
                coderArgs.push("--command", options.command);
            if (apply)
                coderArgs.push("--apply");
            const coder = runner(coderArgs, cwd);
            const coderJson = coder.json;
            const patch = typeof coderJson?.patch === "string" ? coderJson.patch : null;
            const files = Array.isArray(coderJson?.files)
                ? coderJson.files.filter((file) => typeof file === "string")
                : [];
            const applied = coderJson?.applied === true;
            const tests = testResult(coderJson);
            if (!patch) {
                result.rounds.push({
                    round,
                    patch: null,
                    files,
                    applied,
                    tests,
                    findings: [],
                    decision: "кодер не предложил патч",
                });
                result.status = "stopped";
                result.reason = coderJson?.error ? String(coderJson.error) : coder.stderr.trim() || "нет патча";
                return result;
            }
            writeFileSync(patchPath, patch, "utf8");
            const reviewArgs = [
                "review",
                "--json",
                "--diff",
                patchPath,
                "--context",
                `BATTLE_HACKER: attack this patch for ${options.task}. Find correctness, security and test gaps.`,
                ...modelArgs(options),
            ];
            const review = runner(reviewArgs, cwd);
            const securityArgs = ["--json", "--diff", patchPath];
            const sast = runner(["sast", ...securityArgs], cwd);
            const authz = runner(["authz", ...securityArgs], cwd);
            const guard = runner(["test-guard", ...securityArgs], cwd);
            const findings = [
                ...findingsFrom(review.json, "review"),
                ...findingsFrom(sast.json, "sast"),
                ...findingsFrom(authz.json, "authz"),
                ...findingsFrom(guard.json, "test-guard"),
            ];
            const high = findings.filter(isHigh);
            const testsPassed = tests === null || tests.passed;
            const decision = high.length === 0 && (!apply || testsPassed)
                ? "чисто: высоких находок нет, тесты не падают"
                : `осталось высоких находок: ${String(high.length)}${apply && !testsPassed ? ", тесты падают" : ""}`;
            result.rounds.push({ round, patch, files, applied, tests, findings, decision });
            if (high.length === 0 && (!apply || testsPassed)) {
                result.status = "pass";
                result.reason = "high-находок нет, тесты прошли";
                return result;
            }
            if (!apply) {
                result.status = "fail";
                result.reason = "патч не применён: исправить находки можно только с --apply";
                return result;
            }
            previousFindings = high;
        }
        result.status = "fail";
        result.reason = `раунды исчерпаны: ${describeFindings(previousFindings)}`;
        return result;
    }
    finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
}
export function renderBattle(report) {
    const lines = [
        `Задача: ${report.task}`,
        `Статус: ${report.status}${report.reason ? ` — ${report.reason}` : ""}`,
        `Раундов: ${String(report.rounds.length)}, применено: ${report.applied ? "да" : "нет"}.`,
    ];
    for (const round of report.rounds) {
        lines.push("", `Раунд ${String(round.round)}: файлов ${String(round.files.length)}, тесты ${round.tests ? (round.tests.passed ? "прошли" : "упали") : "не запускались"}.`);
        for (const finding of round.findings) {
            lines.push(`  [${finding.source}/${finding.severity}] ${finding.location ?? ""} ${finding.text}`.trim());
        }
        if (round.findings.length === 0)
            lines.push("  Находок нет.");
    }
    return `${lines.join("\n")}\n`;
}
//# sourceMappingURL=battle.js.map