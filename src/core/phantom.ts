import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { PilotError } from "./errors.js";

export type SandboxStatus = "ok" | "blocked" | "error" | "timeout";

export interface SandboxOptions {
  timeoutMs?: number;
  memoryMb?: number;
}

export interface SandboxResult {
  file: string;
  status: SandboxStatus;
  output: string[];
  error?: string;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MEMORY_MB = 128;
const MAX_FILE_BYTES = 256_000;

const WORKER = `import { readFileSync } from "node:fs";
import vm from "node:vm";

const payload = JSON.parse(readFileSync(process.argv[2], "utf8"));
const output = [];
const push = (...args) => output.push(args.map((value) => String(value)).join(" "));
const blocked = (label) => {
  throw new Error("PhantomError: " + label + " blocked");
};
const context = vm.createContext({
  console: { log: push, info: push, warn: push, error: push },
  fetch: () => blocked("fetch"),
  require: (id) => blocked("require(" + id + ")"),
  process: {
    env: {},
    argv: [],
    cwd: () => "/sandbox",
    platform: process.platform,
    exit: () => blocked("process.exit"),
    kill: () => blocked("process.kill"),
  },
  setTimeout: (fn, ms) => {
    if (Number(ms) > 1000) throw new Error("PhantomError: long timer blocked");
    return setTimeout(fn, Number(ms));
  },
  clearTimeout,
  Buffer: undefined,
});

try {
  const code = readFileSync(payload.file, "utf8");
  const isModule = payload.file.endsWith(".mjs") || /^\\s*(?:import|export)\\b/m.test(code);
  if (isModule) {
    const module = new vm.SourceTextModule(code, { context, identifier: payload.file });
    await module.link(() => {
      throw new Error("PhantomError: import blocked");
    });
    await module.evaluate({ timeout: payload.timeoutMs });
  } else {
    new vm.Script(code, { filename: payload.file }).runInContext(context, { timeout: payload.timeoutMs });
  }
  console.log(JSON.stringify({ status: "ok", output }));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const status = message.includes("PhantomError")
    ? "blocked"
    : code === "ERR_SCRIPT_EXECUTION_TIMEOUT" || /timed out/i.test(message)
      ? "timeout"
      : "error";
  console.log(JSON.stringify({ status, output, error: message.slice(0, 500) }));
}
`;

function inside(cwd: string, file: string): string {
  const root = resolve(cwd);
  const target = resolve(root, file);
  const rel = relative(root, target);
  if (rel.startsWith("..") || rel.includes(`..${sep}`) || resolve(root, rel) !== target) {
    throw new PilotError("Путь выходит за пределы проекта", { exitCode: 2 });
  }
  return target;
}

function runnableFile(cwd: string, file: string): { path?: string; reason?: string } {
  if (file.endsWith(".tsx")) return { reason: "TSX не исполняется в vm" };
  if (file.endsWith(".ts")) {
    if (file.startsWith("src/")) {
      const built = join(cwd, "dist", file.slice(4).replace(/\.ts$/, ".js"));
      if (existsSync(built)) return { path: built };
    }
    return { reason: "TypeScript требует собранный JS: sandbox не транспилирует" };
  }
  return { path: inside(cwd, file) };
}

function parseWorker(stdout: string): { status?: string; output?: string[]; error?: string } | undefined {
  const line = stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => value.startsWith("{"))
    .pop();
  if (!line) return undefined;
  try {
    return JSON.parse(line) as { status?: string; output?: string[]; error?: string };
  } catch {
    return undefined;
  }
}

/** Runs one JS/MJS file in node:vm with blocked imports, fs, net, http and child_process. */
export function runSandbox(cwd: string, file: string, options: SandboxOptions = {}): SandboxResult {
  const timeoutMs = Math.max(50, Math.min(30_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const memoryMb = Math.max(16, Math.min(4096, options.memoryMb ?? DEFAULT_MEMORY_MB));
  const target = runnableFile(cwd, file);
  if (!target.path) {
    return { file, status: "error", output: [], error: target.reason, durationMs: 0 };
  }
  if (!existsSync(target.path)) {
    return { file, status: "error", output: [], error: "файл не найден", durationMs: 0 };
  }
  if (statSync(target.path).size > MAX_FILE_BYTES) {
    return { file, status: "error", output: [], error: `файл больше ${String(MAX_FILE_BYTES)} байт`, durationMs: 0 };
  }

  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-phantom-"));
  const started = Date.now();
  try {
    const worker = join(dir, "worker.mjs");
    const payload = join(dir, "payload.json");
    writeFileSync(worker, WORKER, "utf8");
    writeFileSync(payload, JSON.stringify({ file: target.path, timeoutMs }), "utf8");
    const env = { ...process.env };
    env.NODE_V8_COVERAGE = "";
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      ["--experimental-vm-modules", `--max-old-space-size=${String(memoryMb)}`, worker, payload],
      { cwd, env, encoding: "utf8", timeout: timeoutMs + 1000, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024 },
    );
    const durationMs = Date.now() - started;
    if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      return { file, status: "timeout", output: [], error: "worker timeout", durationMs };
    }
    const parsed = parseWorker(result.stdout ?? "");
    if (!parsed) {
      return {
        file,
        status: "error",
        output: [],
        error: (result.stderr || "worker не вернул результат").slice(0, 500),
        durationMs,
      };
    }
    return {
      file,
      status: parsed.status === "ok" || parsed.status === "blocked" || parsed.status === "timeout" ? parsed.status : "error",
      output: parsed.output ?? [],
      error: parsed.error,
      durationMs,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function renderSandbox(result: SandboxResult): string {
  const lines = [`Sandbox: ${result.status} (${String(result.durationMs)} ms) ${result.file}`];
  for (const line of result.output) lines.push(`  ${line}`);
  if (result.error) lines.push(`  ${result.error}`);
  return `${lines.join("\n")}\n`;
}
