import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { PilotError } from "./errors.js";

export type HyperChamberStatus = "ok" | "leak" | "error" | "timeout";

export interface HyperChamberOptions {
  days?: number;
  budgetMs?: number;
  memoryMb?: number;
}

export interface HyperChamberResult {
  file: string;
  status: HyperChamberStatus;
  simulatedDays: number;
  iterations: number;
  samples: number;
  firstHeap: number;
  lastHeap: number;
  growth: number;
  slopePerDay: number;
  crashDay: number;
  output: string[];
  error?: string;
  durationMs: number;
  summary: string;
}

const DEFAULT_DAYS = 365;
const DEFAULT_BUDGET_MS = 2_000;
const DEFAULT_MEMORY_MB = 128;
const MAX_ITERATIONS = 100_000;
const MAX_FILE_BYTES = 256_000;

const WORKER = `import { readFileSync } from "node:fs";
import vm from "node:vm";
import v8 from "node:v8";

const payload = JSON.parse(readFileSync(process.argv[2], "utf8"));
const output = [];
const push = (...args) => {
  if (output.length >= 60) return;
  output.push(args.map((value) => String(value)).join(" "));
};
const blocked = (label) => {
  throw new Error("ChamberError: " + label + " blocked");
};

const DAY_MS = 86400000;
const simStart = Date.UTC(2026, 0, 1);
let simulatedNow = simStart;
let timerId = 0;
const timers = new Map();
const schedule = (fn, ms, interval) => {
  const id = ++timerId;
  const delay = Math.max(0, Math.min(1000, Number(ms) || 0));
  const fire = () => {
    try {
      fn();
    } catch (error) {
      push("timer error: " + (error instanceof Error ? error.message : String(error)));
    }
    const current = timers.get(id);
    if (!current) return;
    current.count += 1;
    if (interval && current.count < 5) {
      current.handle = setTimeout(fire, Math.min(delay, 1));
    } else {
      timers.delete(id);
    }
  };
  const handle = setTimeout(fire, Math.min(delay, 1));
  timers.set(id, { handle, count: 0 });
  return id;
};
const clearTimer = (id) => {
  const record = timers.get(id);
  if (!record) return;
  clearTimeout(record.handle);
  timers.delete(id);
};

class FakeDate extends Date {
  constructor(...args) {
    if (args.length === 0) super(simulatedNow);
    else super(...args);
  }
  static now() {
    return simulatedNow;
  }
}

const context = vm.createContext({
  console: { log: push, info: push, warn: push, error: push, debug: push },
  fetch: () => blocked("fetch"),
  require: (id) => blocked("require(" + id + ")"),
  process: {
    env: {},
    argv: [],
    cwd: () => "/chamber",
    platform: process.platform,
    exit: () => blocked("process.exit"),
    kill: () => blocked("process.kill"),
    memoryUsage: () => process.memoryUsage(),
    hrtime: process.hrtime,
  },
  setTimeout: (fn, ms) => schedule(fn, ms, false),
  setInterval: (fn, ms) => schedule(fn, ms, true),
  clearTimeout: clearTimer,
  clearInterval: clearTimer,
  Date: FakeDate,
  gc: () => {
    if (typeof global.gc === "function") global.gc();
  },
  Buffer: undefined,
});

const code = readFileSync(payload.file, "utf8");
const isModule = payload.file.endsWith(".mjs") || /^\\s*(?:import|export)\\b/m.test(code);
let entry;
let entryScript;
let plainScript;
if (isModule) {
  const module = new vm.SourceTextModule(code, { context, identifier: payload.file });
  await module.link(() => {
    throw new Error("ChamberError: import blocked");
  });
  await module.evaluate();
  const names = ["run", "tick", "main", "default"];
  const name = names.find((candidate) => typeof module.namespace[candidate] === "function");
  if (!name) {
    throw new Error("ChamberError: export a function named run, tick, main or default");
  }
  entry = module.namespace[name];
  entryScript = new vm.Script("__chamberEntry()", { filename: "hyper-chamber-entry" });
} else {
  plainScript = new vm.Script("(function(){\\n" + code + "\\n})()", { filename: payload.file });
}

const runOnce = () => {
  if (entry) {
    context.__chamberEntry = entry;
    try {
      return entryScript.runInContext(context);
    } finally {
      context.__chamberEntry = undefined;
    }
  }
  return plainScript.runInContext(context);
};

const realSetTimeout = setTimeout;

const memoryLimitBytes = payload.memoryMb * 1024 * 1024;
const started = performance.now();
const samples = [];
let iterations = 0;
let status = "ok";
let error;
let lastSampleAt = 0;

const sample = () => {
  if (typeof global.gc === "function") global.gc();
  const heap = v8.getHeapStatistics().used_heap_size;
  const day = Math.max(0, (simulatedNow - simStart) / DAY_MS);
  samples.push({ day, heap });
  if (samples.length > 500) samples.shift();
};

try {
  while (iterations < payload.maxIterations) {
    const elapsed = performance.now() - started;
    if (elapsed >= payload.budgetMs) break;
    simulatedNow = simStart + Math.round(payload.days * DAY_MS * (elapsed / payload.budgetMs));
    const result = runOnce();
    if (result && typeof result.then === "function") {
      await result;
    }
    iterations += 1;
    const now = performance.now() - started;
    if (now - lastSampleAt >= 50 || iterations % 1000 === 0) {
      sample();
      lastSampleAt = now;
    }
    if (iterations % 1000 === 0) {
      await new Promise((resolveTick) => realSetTimeout(resolveTick, 0));
    }
  }
  simulatedNow = simStart + Math.round(payload.days * DAY_MS * Math.min(1, (performance.now() - started) / payload.budgetMs));
  sample();
} catch (caught) {
  const message = caught instanceof Error ? caught.message : String(caught);
  const code = caught && typeof caught === "object" && "code" in caught ? String(caught.code) : "";
  if (message.includes("iteration timeout") || code === "ERR_SCRIPT_EXECUTION_TIMEOUT" || /timed out/i.test(message)) {
    status = "timeout";
  } else {
    status = "error";
  }
  error = message.slice(0, 500);
}

for (const record of timers.values()) clearTimeout(record.handle);
timers.clear();
if (samples.length === 0) sample();

const simulatedDays = Math.max(0, Math.round((simulatedNow - simStart) / DAY_MS));
const firstHeap = samples.length > 0 ? samples[0].heap : 0;
const lastHeap = samples.length > 0 ? samples[samples.length - 1].heap : 0;
let growth = firstHeap > 0 && lastHeap > 0 ? lastHeap / firstHeap : 0;
let slopePerDay = 0;
let crashDay = simulatedDays;
let summary = "";

const warmup = Math.min(Math.max(0, samples.length - 1), Math.max(2, Math.floor(samples.length * 0.2)));
const usable = samples.slice(warmup);
if (usable.length >= 4 && status === "ok") {
  const third = Math.max(1, Math.floor(usable.length / 3));
  const median = (values) => {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
  };
  const earlyMedian = median(usable.slice(0, third).map((point) => point.heap));
  const lateMedian = median(usable.slice(-third).map((point) => point.heap));
  growth = earlyMedian > 0 ? lateMedian / earlyMedian : 0;
  const absolute = lateMedian - earlyMedian;
  const count = usable.length;
  const meanX = usable.reduce((sum, point) => sum + point.day, 0) / count;
  const meanY = usable.reduce((sum, point) => sum + point.heap, 0) / count;
  let numerator = 0;
  let denominator = 0;
  let total = 0;
  for (const point of usable) {
    const dx = point.day - meanX;
    numerator += dx * (point.heap - meanY);
    denominator += dx * dx;
    total += (point.heap - meanY) * (point.heap - meanY);
  }
  slopePerDay = denominator > 0 ? numerator / denominator : 0;
  let residual = 0;
  for (const point of usable) {
    const predicted = meanY + slopePerDay * (point.day - meanX);
    residual += (point.heap - predicted) * (point.heap - predicted);
  }
  const r2 = total > 0 ? 1 - residual / total : 0;
  const nearLimit = lateMedian >= memoryLimitBytes * 0.75;
  const leaking = nearLimit || (growth >= 1.2 && absolute >= 512 * 1024 && slopePerDay > 0 && r2 >= 0.35);
  if (leaking) {
    status = "leak";
    const currentDay = usable[usable.length - 1].day;
    if (slopePerDay > 0) {
      crashDay = Math.max(1, Math.min(payload.days, Math.round(currentDay + (memoryLimitBytes - lateMedian) / slopePerDay)));
    } else {
      crashDay = Math.max(1, Math.min(payload.days, Math.round(currentDay)));
    }
    summary = "[MEMORY LEAK DETECTED]: AI code survives Day 1, but crashes on Day " + String(crashDay) + " of simulated uptime.";
  } else {
    summary = "Утечек не обнаружено: heap стабилен на " + String(simulatedDays) + " симулированных суток.";
  }
} else if (status === "ok") {
  summary = "Недостаточно замеров heap для вывода: " + String(samples.length) + " sample(s).";
}
if (status === "timeout") {
  summary = "Симуляция остановлена по таймауту на " + String(simulatedDays) + " сутках.";
}
if (status === "error") {
  summary = "Симуляция остановлена ошибкой: " + (error || "unknown");
}

console.log(JSON.stringify({
  status,
  simulatedDays,
  iterations,
  samples: samples.length,
  firstHeap,
  lastHeap,
  growth,
  slopePerDay,
  crashDay,
  output,
  error,
  durationMs: Math.round(performance.now() - started),
  summary,
}));
`;

interface WorkerResult {
  status?: string;
  simulatedDays?: number;
  iterations?: number;
  samples?: number;
  firstHeap?: number;
  lastHeap?: number;
  growth?: number;
  slopePerDay?: number;
  crashDay?: number;
  output?: string[];
  error?: string;
  durationMs?: number;
  summary?: string;
}

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
    return { reason: "TypeScript требует собранный JS: hyper-chamber не транспилирует" };
  }
  return { path: inside(cwd, file) };
}

function parseWorker(stdout: string): WorkerResult | undefined {
  const line = stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => value.startsWith("{"))
    .pop();
  if (!line) return undefined;
  try {
    return JSON.parse(line) as WorkerResult;
  } catch {
    return undefined;
  }
}

function summaryFor(file: string, status: HyperChamberStatus, days: number, error?: string): string {
  if (status === "leak") {
    return `[MEMORY LEAK DETECTED]: AI code survives Day 1, but crashes on Day ${String(days)} of simulated uptime.`;
  }
  if (status === "timeout") return `Симуляция остановлена по таймауту на ${String(days)} сутках.`;
  if (status === "error") return `Симуляция остановлена ошибкой: ${error ?? "unknown"}`;
  return `Утечек не обнаружено: ${file}.`;
}

/** Ages one self-contained JS/ESM file in a vm and looks for sustained heap growth. */
export function runHyperChamber(cwd: string, file: string, options: HyperChamberOptions = {}): HyperChamberResult {
  const days = Math.max(1, Math.min(3_650, Math.round(options.days ?? DEFAULT_DAYS)));
  const budgetMs = Math.max(100, Math.min(30_000, Math.round(options.budgetMs ?? DEFAULT_BUDGET_MS)));
  const memoryMb = Math.max(16, Math.min(4_096, Math.round(options.memoryMb ?? DEFAULT_MEMORY_MB)));
  const target = runnableFile(cwd, file);
  if (!target.path) {
    return {
      file,
      status: "error",
      simulatedDays: 0,
      iterations: 0,
      samples: 0,
      firstHeap: 0,
      lastHeap: 0,
      growth: 0,
      slopePerDay: 0,
      crashDay: 0,
      output: [],
      error: target.reason,
      durationMs: 0,
      summary: summaryFor(file, "error", 0, target.reason),
    };
  }
  if (!existsSync(target.path)) {
    return {
      file,
      status: "error",
      simulatedDays: 0,
      iterations: 0,
      samples: 0,
      firstHeap: 0,
      lastHeap: 0,
      growth: 0,
      slopePerDay: 0,
      crashDay: 0,
      output: [],
      error: "файл не найден",
      durationMs: 0,
      summary: summaryFor(file, "error", 0, "файл не найден"),
    };
  }
  if (statSync(target.path).size > MAX_FILE_BYTES) {
    const error = `файл больше ${String(MAX_FILE_BYTES)} байт`;
    return {
      file,
      status: "error",
      simulatedDays: 0,
      iterations: 0,
      samples: 0,
      firstHeap: 0,
      lastHeap: 0,
      growth: 0,
      slopePerDay: 0,
      crashDay: 0,
      output: [],
      error,
      durationMs: 0,
      summary: summaryFor(file, "error", 0, error),
    };
  }

  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-hyper-chamber-"));
  const started = Date.now();
  try {
    const worker = join(dir, "worker.mjs");
    const payload = join(dir, "payload.json");
    writeFileSync(worker, WORKER, "utf8");
    writeFileSync(
      payload,
      JSON.stringify({
        file: target.path,
        days,
        budgetMs,
        memoryMb,
        maxIterations: MAX_ITERATIONS,
        iterationTimeoutMs: 250,
      }),
      "utf8",
    );
    const env = { ...process.env };
    env.NODE_V8_COVERAGE = "";
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      ["--expose-gc", "--experimental-vm-modules", `--max-old-space-size=${String(memoryMb)}`, worker, payload],
      { cwd, env, encoding: "utf8", timeout: budgetMs + 10_000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 },
    );
    const durationMs = Date.now() - started;
    if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      return {
        file,
        status: "timeout",
        simulatedDays: days,
        iterations: 0,
        samples: 0,
        firstHeap: 0,
        lastHeap: 0,
        growth: 0,
        slopePerDay: 0,
        crashDay: 0,
        output: [],
        error: "worker timeout",
        durationMs,
        summary: summaryFor(file, "timeout", days),
      };
    }
    const parsed = parseWorker(result.stdout ?? "");
    if (!parsed) {
      const stderr = result.stderr ?? "";
      if (/heap out of memory|JavaScript heap out of memory/i.test(stderr)) {
        return {
          file,
          status: "leak",
          simulatedDays: days,
          iterations: 0,
          samples: 0,
          firstHeap: 0,
          lastHeap: 0,
          growth: 0,
          slopePerDay: 0,
          crashDay: days,
          output: [],
          error: "heap exhausted during simulation",
          durationMs,
          summary: summaryFor(file, "leak", days),
        };
      }
      const error = (stderr || "worker не вернул результат").slice(0, 500);
      return {
        file,
        status: "error",
        simulatedDays: 0,
        iterations: 0,
        samples: 0,
        firstHeap: 0,
        lastHeap: 0,
        growth: 0,
        slopePerDay: 0,
        crashDay: 0,
        output: [],
        error,
        durationMs,
        summary: summaryFor(file, "error", 0, error),
      };
    }
    const status: HyperChamberStatus =
      parsed.status === "ok" || parsed.status === "leak" || parsed.status === "timeout" || parsed.status === "error"
        ? parsed.status
        : "error";
    const summary =
      typeof parsed.summary === "string" && parsed.summary.trim()
        ? parsed.summary
        : summaryFor(file, status, parsed.simulatedDays ?? days, parsed.error);
    return {
      file,
      status,
      simulatedDays: typeof parsed.simulatedDays === "number" ? parsed.simulatedDays : 0,
      iterations: typeof parsed.iterations === "number" ? parsed.iterations : 0,
      samples: typeof parsed.samples === "number" ? parsed.samples : 0,
      firstHeap: typeof parsed.firstHeap === "number" ? parsed.firstHeap : 0,
      lastHeap: typeof parsed.lastHeap === "number" ? parsed.lastHeap : 0,
      growth: typeof parsed.growth === "number" ? parsed.growth : 0,
      slopePerDay: typeof parsed.slopePerDay === "number" ? parsed.slopePerDay : 0,
      crashDay: typeof parsed.crashDay === "number" ? parsed.crashDay : 0,
      output: Array.isArray(parsed.output) ? parsed.output.filter((line): line is string => typeof line === "string") : [],
      error: typeof parsed.error === "string" ? parsed.error : undefined,
      durationMs,
      summary,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function renderHyperChamber(result: HyperChamberResult): string {
  const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  const lines = [
    `Hyper chamber: ${result.status} (${(result.durationMs / 1000).toFixed(1)}s, ${String(result.simulatedDays)} simulated days) ${result.file}`,
    `  iterations: ${String(result.iterations)}`,
  ];
  if (result.samples > 0) {
    lines.push(`  heap: ${mb(result.firstHeap)} -> ${mb(result.lastHeap)} (x${result.growth.toFixed(2)})`);
  }
  lines.push(`  ${result.summary}`);
  for (const line of result.output) lines.push(`  ${line}`);
  return `${lines.join("\n")}\n`;
}
