import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addedLinesByFile } from "./autopsy.js";
import { isCodeFile, isGeneratedPath, isTestFile } from "./slop/source.js";
const DEFAULT_DURATION_MS = 2_000;
const DEFAULT_MEMORY_MB = 128;
const DEFAULT_MAX_TARGETS = 10;
const PER_TARGET_TIMEOUT_MS = 2_000;
const MAX_FILE_BYTES = 256_000;
const SIDE_EFFECT = /(?:from\s+["'](?:node:)?(?:fs|net|http|https|child_process)["']|require\(\s*["'](?:node:)?(?:fs|net|http|https|child_process)["']\s*\)|\bfetch\s*\(|\bprocess\.env\b)/;
const EXPORT_FUNCTION = /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/;
const EXPORT_ARROW = /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\(([^)]*)\)|[A-Za-z_$][\w$]*)\s*=>/;
const EXPORT_FUNCTION_EXPRESSION = /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?function\b/;
const FUZZ_WORKER = `import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const payload = JSON.parse(readFileSync(process.argv[2], "utf8"));
const require = createRequire(import.meta.url);
const blocked = (label) => {
  throw new Error("FuzzError: Side effect blocked (" + label + ")");
};
const output = [];
try {
  const mod = await import(pathToFileURL(payload.file).href);
  const fn = mod[payload.name];
  if (typeof fn !== "function") {
    console.log(JSON.stringify({ status: "skipped", reason: "export is not a function" }));
    process.exit(0);
  }
  // Patch side-effect modules only after the target is loaded, so its own
  // import graph still resolves; files that import them are blocked earlier.
  for (const id of ["fs", "node:fs", "net", "node:net", "http", "node:http", "https", "node:https", "child_process", "node:child_process"]) {
    try {
      const mod = require(id);
      for (const key of Object.keys(mod)) {
        if (typeof mod[key] === "function") mod[key] = () => blocked(id);
      }
    } catch {}
  }
  globalThis.fetch = () => blocked("fetch");
  for (const item of payload.inputs) {
    const count = Math.min(Math.max(payload.arity, 1), 3);
    const args = Array.from({ length: count }, () => item.value);
    try {
      await fn(...args);
      output.push({ status: "ok", input: item.label });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("FuzzError: Side effect blocked")) {
        output.push({ status: "blocked", input: item.label, error: message });
        break;
      }
      output.push({ status: "crash", input: item.label, error: message.slice(0, 500) });
    }
  }
} catch (error) {
  output.push({ status: "skipped", input: "import", error: error instanceof Error ? error.message.slice(0, 500) : String(error) });
}
console.log(JSON.stringify({ status: "done", results: output }));
`;
function readSource(cwd, file) {
    const path = join(cwd, file);
    if (!existsSync(path))
        return undefined;
    try {
        const text = readFileSync(path, "utf8"); // oc-pilot:sast-ignore path-traversal: путь приходит из локального CLI, а не из запроса
        return text.length > MAX_FILE_BYTES ? undefined : text;
    }
    catch {
        return undefined;
    }
}
function arityOf(params) {
    if (!params || !params.trim())
        return 0;
    return params
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0 && !part.startsWith("...")).length;
}
/** Finds exported functions declared on added lines of the diff. */
export function discoverFuzzTargets(cwd, diff, limit = DEFAULT_MAX_TARGETS) {
    const added = addedLinesByFile(diff);
    const targets = [];
    const seen = new Set();
    for (const [file, lines] of added) {
        if (!isCodeFile(file) || isTestFile(file) || isGeneratedPath(file))
            continue;
        const text = readSource(cwd, file);
        if (!text)
            continue;
        const blocked = SIDE_EFFECT.test(text) ? "side-effect import or call" : undefined;
        const rows = text.split("\n");
        for (let index = 0; index < rows.length; index += 1) {
            if (!lines.has(index + 1))
                continue;
            const line = rows[index];
            const functionMatch = EXPORT_FUNCTION.exec(line);
            const arrowMatch = EXPORT_ARROW.exec(line);
            const expressionMatch = EXPORT_FUNCTION_EXPRESSION.exec(line);
            const name = functionMatch?.[1] ?? arrowMatch?.[1] ?? expressionMatch?.[1];
            if (!name || seen.has(`${file}#${name}`))
                continue;
            seen.add(`${file}#${name}`);
            targets.push({
                file,
                name,
                arity: arityOf(functionMatch?.[2] ?? arrowMatch?.[2]),
                ...(blocked ? { blocked } : {}),
            });
            if (targets.length >= limit)
                return targets;
        }
    }
    return targets;
}
/** Prefers the built JavaScript next to a TypeScript source, so imports resolve. */
function runFile(cwd, file) {
    if (file.endsWith(".tsx"))
        return undefined;
    if (file.startsWith("src/") && file.endsWith(".ts")) {
        const built = join(cwd, "dist", file.slice(4).replace(/\.ts$/, ".js"));
        if (existsSync(built))
            return built;
    }
    const source = join(cwd, file);
    return existsSync(source) ? source : undefined;
}
function fuzzInputs() {
    return [
        { label: "null", value: null },
        { label: "undefined", value: undefined },
        { label: "-1", value: -1 },
        { label: "0", value: 0 },
        { label: "empty string", value: "" },
        { label: "10MB string", value: "A".repeat(10 * 1024 * 1024) },
        { label: "__proto__ object", value: JSON.parse('{"__proto__":{"polluted":true}}') },
        { label: "empty array", value: [] },
        { label: "empty object", value: {} },
    ];
}
function parseWorker(stdout) {
    const line = stdout
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter((value) => value.startsWith("{"))
        .pop();
    if (!line)
        return undefined;
    try {
        return JSON.parse(line);
    }
    catch {
        return undefined;
    }
}
/** Runs one target in a separate process with mocks, a hard timeout and a heap cap. */
function runTarget(cwd, target, timeoutMs, memoryMb, inputs) {
    const file = runFile(cwd, target.file);
    if (!file) {
        return { file: target.file, name: target.name, status: "skipped", findings: [], durationMs: 0, reason: "нет запускаемого файла" };
    }
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-fuzz-"));
    const started = Date.now();
    try {
        const worker = join(dir, "worker.mjs");
        const payload = join(dir, "payload.json");
        writeFileSync(worker, FUZZ_WORKER, "utf8");
        writeFileSync(payload, JSON.stringify({ file, name: target.name, arity: target.arity, inputs }), "utf8");
        const args = [`--max-old-space-size=${String(memoryMb)}`];
        if (file.endsWith(".ts"))
            args.push("--experimental-strip-types");
        args.push(worker, payload);
        const result = spawnSync(process.execPath, args, {
            cwd,
            encoding: "utf8",
            timeout: timeoutMs,
            killSignal: "SIGKILL",
            maxBuffer: 4 * 1024 * 1024,
        });
        const durationMs = Date.now() - started;
        if (result.error && result.error.code === "ETIMEDOUT") {
            return { file: target.file, name: target.name, status: "timeout", findings: [], durationMs, reason: "2000 ms" };
        }
        const output = parseWorker(result.stdout ?? "");
        if (!output?.results || output.results.length === 0) {
            return {
                file: target.file,
                name: target.name,
                status: "skipped",
                findings: [],
                durationMs,
                reason: output?.reason ?? (result.stderr || "worker не вернул результат").slice(0, 300),
            };
        }
        const importSkip = output.results.find((item) => item.status === "skipped" && item.input === "import");
        if (importSkip) {
            return {
                file: target.file,
                name: target.name,
                status: "skipped",
                findings: [],
                durationMs,
                reason: importSkip.error ?? "не удалось загрузить модуль",
            };
        }
        const blocked = output.results.find((item) => item.status === "blocked");
        if (blocked) {
            return {
                file: target.file,
                name: target.name,
                status: "blocked",
                findings: [{ input: blocked.input ?? "?", error: blocked.error ?? "FuzzError: Side effect blocked" }],
                durationMs,
                reason: "побочный эффект",
            };
        }
        const crashes = output.results
            .filter((item) => item.status === "crash")
            .map((item) => ({ input: item.input ?? "?", error: item.error ?? "unknown" }));
        if (crashes.length > 0) {
            return { file: target.file, name: target.name, status: "crash", findings: crashes, durationMs };
        }
        return { file: target.file, name: target.name, status: "clean", findings: [], durationMs };
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
export function runFuzz(cwd, diff, options = {}) {
    const durationMs = Math.max(100, options.durationMs ?? DEFAULT_DURATION_MS);
    const memoryMb = Math.max(16, Math.min(4096, options.memoryMb ?? DEFAULT_MEMORY_MB));
    const targets = discoverFuzzTargets(cwd, diff, options.maxTargets ?? DEFAULT_MAX_TARGETS);
    const inputs = options.inputs ?? fuzzInputs();
    const results = [];
    const started = Date.now();
    for (const target of targets) {
        const remaining = durationMs - (Date.now() - started);
        if (remaining <= 0) {
            results.push({
                file: target.file,
                name: target.name,
                status: "skipped",
                findings: [],
                durationMs: 0,
                reason: "исчерпан бюджет --duration",
            });
            continue;
        }
        if (target.blocked) {
            results.push({
                file: target.file,
                name: target.name,
                status: "blocked",
                findings: [],
                durationMs: 0,
                reason: `не фаззим: ${target.blocked}`,
            });
            continue;
        }
        results.push(runTarget(cwd, target, Math.min(options.perTargetTimeoutMs ?? PER_TARGET_TIMEOUT_MS, remaining), memoryMb, inputs));
    }
    const crashes = results.filter((result) => result.status === "crash").length;
    const blocked = results.filter((result) => result.status === "blocked").length;
    const timeouts = results.filter((result) => result.status === "timeout").length;
    const report = {
        durationMs,
        memoryMb,
        targets,
        results,
        crashes,
        blocked,
        timeouts,
        exitCode: options.failOnCrash === true && crashes > 0 ? 1 : 0,
        content: "",
    };
    report.content = renderFuzz(report);
    return report;
}
export function renderFuzz(report) {
    const lines = [
        `Фаззинг: целей ${String(report.targets.length)}, падений ${String(report.crashes)}, заблокировано ${String(report.blocked)}, таймаутов ${String(report.timeouts)}.`,
    ];
    for (const result of report.results) {
        const marker = result.status === "crash"
            ? "[CRASH]"
            : result.status === "blocked"
                ? "[BLOCKED]"
                : result.status === "timeout"
                    ? "[TIMEOUT]"
                    : result.status === "skipped"
                        ? "[SKIPPED]"
                        : "[CLEAN]";
        lines.push(`${marker} ${result.file}#${result.name} (${String(result.durationMs)} ms)${result.reason ? `: ${result.reason}` : ""}`);
        for (const finding of result.findings) {
            lines.push(`  input=${finding.input}: ${finding.error}`);
        }
    }
    if (report.targets.length === 0)
        lines.push("В diff нет новых экспортируемых функций.");
    return `${lines.join("\n")}\n`;
}
//# sourceMappingURL=fuzz.js.map