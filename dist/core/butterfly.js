import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runShellCommand } from "./command.js";
import { PilotError } from "./errors.js";
const DEFAULT_SEED = 42;
const DEFAULT_FAIL_RATE = 0.1;
const DEFAULT_LATENCY_RATE = 0.05;
const DEFAULT_LATENCY_MS = 3_000;
const DEFAULT_BROKEN_JSON_RATE = 0.02;
const DEFAULT_FS_FAIL_RATE = 0.05;
const DEFAULT_TIMEOUT_MS = 120_000;
function rate(value, fallback) {
    const parsed = value ?? fallback;
    return Math.max(0, Math.min(1, parsed));
}
function parseFaults(path) {
    const faults = { http500: 0, latency: 0, brokenJson: 0, fsError: 0, dbError: 0 };
    if (!existsSync(path))
        return faults;
    let text = "";
    try {
        text = readFileSync(path, "utf8");
    }
    catch {
        return faults;
    }
    for (const line of text.split(/\r?\n/)) {
        if (!line.trim())
            continue;
        try {
            const event = JSON.parse(line);
            if (event.type === "http500" || event.type === "latency" || event.type === "brokenJson" || event.type === "fsError" || event.type === "dbError") {
                faults[event.type] += 1;
            }
        }
        catch {
            // Ignore malformed log lines from a crashed child.
        }
    }
    return faults;
}
function total(faults) {
    return faults.http500 + faults.latency + faults.brokenJson + faults.fsError + faults.dbError;
}
function stripAnsi(text) {
    return text.replace(/\u001B\[[0-9;]*m/g, "");
}
function makeSummary(status, faults) {
    const count = total(faults);
    const detail = `http500=${String(faults.http500)}, latency=${String(faults.latency)}, brokenJson=${String(faults.brokenJson)}, fsError=${String(faults.fsError)}, dbError=${String(faults.dbError)}`;
    if (status === "timeout") {
        return `Butterfly: тесты прерваны по таймауту; инъекций: ${String(count)} (${detail}).`;
    }
    if (status === "fail") {
        return `Butterfly: тесты упали под хаосом; инъекций: ${String(count)} (${detail}). Проверьте try/catch, таймауты и fallback.`;
    }
    return `Butterfly: тесты прошли под хаосом; инъекций: ${String(count)} (${detail}).`;
}
/** Runs the project test command with deterministic fetch/fs/db fault injection. */
export async function runButterfly(cwd, options) {
    const seed = Math.max(0, Math.floor(options.seed ?? DEFAULT_SEED));
    const failRate = rate(options.failRate, DEFAULT_FAIL_RATE);
    const latencyRate = rate(options.latencyRate, DEFAULT_LATENCY_RATE);
    const latencyMs = Math.max(0, Math.round(options.latencyMs ?? DEFAULT_LATENCY_MS));
    const brokenJsonRate = rate(options.brokenJsonRate, DEFAULT_BROKEN_JSON_RATE);
    const fsFailRate = rate(options.fsFailRate, DEFAULT_FS_FAIL_RATE);
    const timeoutMs = Math.max(1_000, Math.round(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    const scope = options.scope && options.scope.length > 0 ? options.scope : ["src/"];
    const preload = fileURLToPath(new URL("./butterfly-preload.js", import.meta.url));
    if (!existsSync(preload)) {
        throw new PilotError("Не найден butterfly-preload.js", {
            hint: "Соберите проект: npm run build.",
            exitCode: 2,
        });
    }
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-butterfly-"));
    const log = join(dir, "faults.jsonl");
    try {
        const nodeOptions = [process.env.NODE_OPTIONS, `--import ${pathToFileURL(preload).href}`]
            .filter((value) => typeof value === "string" && value.trim().length > 0)
            .join(" ");
        const result = await runShellCommand(options.command, cwd, {
            timeoutMs,
            env: {
                NODE_OPTIONS: nodeOptions,
                OC_PILOT_BUTTERFLY: JSON.stringify({
                    seed,
                    failRate,
                    latencyRate,
                    latencyMs,
                    brokenJsonRate,
                    fsFailRate,
                    scope,
                }),
                OC_PILOT_BUTTERFLY_LOG: log,
            },
        });
        const faults = parseFaults(log);
        const status = result.timedOut ? "timeout" : result.exitCode === 0 ? "pass" : "fail";
        return {
            command: options.command,
            seed,
            status,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            durationMs: result.durationMs,
            faults,
            totalFaults: total(faults),
            output: stripAnsi(result.output).slice(-4_000),
            summary: makeSummary(status, faults),
        };
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
export function renderButterfly(report) {
    const lines = [
        `Butterfly: ${report.status} (${(report.durationMs / 1000).toFixed(1)}s)`,
        `  command: ${report.command}`,
        `  seed: ${String(report.seed)}`,
        `  faults: ${String(report.totalFaults)} (http500=${String(report.faults.http500)}, latency=${String(report.faults.latency)}, brokenJson=${String(report.faults.brokenJson)}, fsError=${String(report.faults.fsError)}, dbError=${String(report.faults.dbError)})`,
        `  exit: ${String(report.exitCode)}${report.timedOut ? " (timeout)" : ""}`,
        `  ${report.summary}`,
    ];
    if (report.output.trim()) {
        lines.push("  --- output tail ---");
        for (const line of report.output.trimEnd().split(/\r?\n/).slice(-30))
            lines.push(`  ${line}`);
    }
    return `${lines.join("\n")}\n`;
}
//# sourceMappingURL=butterfly.js.map