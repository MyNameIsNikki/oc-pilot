import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PilotError } from "./errors.js";

export interface CuckooCapability {
  kind: string;
  detail: string;
}

export type CuckooStatus = "clean" | "capabilities" | "blocked" | "timeout" | "error";

export interface CuckooReport {
  status: CuckooStatus;
  file: string;
  capabilities: CuckooCapability[];
  output: string[];
  error?: string;
  summary: string;
  content: string;
}

export interface CuckooOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_FILE_BYTES = 1024 * 1024;

const WORKER = String.raw`
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const payload = JSON.parse(readFileSync(process.argv[2], "utf8"));
const code = readFileSync(payload.file, "utf8");
const capabilities = [];
const output = [];
const record = (kind, detail) => {
  const value = String(detail).slice(0, 200);
  if (!capabilities.some((item) => item.kind === kind && item.detail === value)) {
    capabilities.push({ kind: kind, detail: value });
  }
};
const push = (...args) => {
  if (output.length < 60) output.push(args.map((value) => String(value)).join(" "));
};
const denied = (kind, detail) => {
  record(kind, detail);
  const error = new Error("CAPABILITY_DENIED");
  error.capability = kind;
  throw error;
};
const fakeResponse = { ok: false, status: 403, text: async () => "", json: async () => ({}) };
const fsMock = {
  readFileSync: (path) => { record("fs", "read:" + path); return ""; },
  readFile: (path, options, callback) => { record("fs", "read:" + path); const cb = typeof options === "function" ? options : callback; if (cb) cb(null, ""); },
  writeFileSync: (path) => { record("fs", "write:" + path); },
  appendFileSync: (path) => { record("fs", "append:" + path); },
  unlinkSync: (path) => { record("fs", "delete:" + path); },
  rmSync: (path) => { record("fs", "delete:" + path); },
  mkdirSync: (path) => { record("fs", "mkdir:" + path); },
  readdirSync: (path) => { record("fs", "readdir:" + path); return []; },
  existsSync: (path) => { record("fs", "exists:" + path); return false; },
  openSync: (path) => { record("fs", "open:" + path); return 0; }
};
const netMock = {
  fetch: (url) => { record("net", "fetch:" + url); return Promise.resolve(fakeResponse); },
  request: (options) => { record("net", "request:" + (typeof options === "string" ? options : options && options.host)); return { on: () => {}, end: () => {}, write: () => {}, destroy: () => {} }; },
  connect: (options) => { record("net", "connect:" + (typeof options === "string" ? options : options && options.host)); return { on: () => {}, end: () => {}, write: () => {}, destroy: () => {} }; }
};
const childMock = {
  exec: (cmd, callback) => { record("child_process", "exec:" + cmd); if (typeof callback === "function") callback(null, "", ""); },
  execSync: (cmd) => { record("child_process", "exec:" + cmd); return ""; },
  spawn: (cmd) => { record("child_process", "spawn:" + cmd); return { on: () => {}, stdout: { on: () => {} }, stderr: { on: () => {} }, kill: () => {} }; },
  spawnSync: (cmd) => { record("child_process", "spawn:" + cmd); return { status: 0, stdout: "", stderr: "" }; },
  fork: (cmd) => { record("child_process", "fork:" + cmd); return { on: () => {}, kill: () => {} }; }
};
const envProxy = new Proxy({}, {
  get: (_target, key) => { record("env", "get:" + String(key)); return undefined; },
  has: () => true,
  ownKeys: () => []
});
const processMock = {
  env: envProxy,
  exit: (code) => denied("exit", "exit:" + code),
  cwd: () => "/sandbox",
  platform: process.platform,
  argv: [],
  version: process.version,
  nextTick: (fn) => fn()
};
const requireMock = (id) => {
  record("require", id);
  if (id === "fs" || id === "node:fs") return fsMock;
  if (id === "http" || id === "node:http" || id === "https" || id === "node:https" || id === "net" || id === "node:net" || id === "dns" || id === "node:dns") return netMock;
  if (id === "child_process" || id === "node:child_process") return childMock;
  return {};
};
const context = vm.createContext({
  console: { log: push, error: push, warn: push, info: push },
  process: processMock,
  fs: fsMock,
  require: requireMock,
  fetch: netMock.fetch,
  http: netMock,
  https: netMock,
  net: netMock,
  child_process: childMock,
  module: { exports: {} },
  exports: {},
  Buffer: Buffer,
  URL: URL,
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {}
});
let status = "clean";
let error;
if (/^\s*(?:import|export)\s/m.test(code)) {
  record("import", "static module syntax");
  status = "blocked";
} else {
  try {
    vm.runInContext(code, context, { filename: payload.file, timeout: payload.scriptTimeoutMs });
    if (capabilities.length > 0) status = "capabilities";
  } catch (caught) {
    if (caught && caught.capability) status = "blocked";
    else if (caught && /timed out/i.test(String(caught.message))) status = "timeout";
    else status = "error";
    error = caught && caught.message ? String(caught.message) : String(caught);
  }
}
process.stdout.write(JSON.stringify({ status: status, capabilities: capabilities, output: output, error: error }));
`;

function cap(output: string): string {
  return output.length > 2_000 ? output.slice(0, 2_000) : output;
}

function renderSummary(status: CuckooStatus, capabilities: CuckooCapability[], error?: string): string {
  const kinds = [...new Set(capabilities.map((item) => item.kind))];
  if (status === "clean") {
    return "[CAPABILITY CLEAN]: код не запросил fs, net, child_process, env, exit, require или import.";
  }
  if (status === "timeout") {
    return "[CUCKOO TIMEOUT]: код не завершился за отведённое время.";
  }
  if (status === "error") {
    return `[CUCKOO ERROR]: ${error ?? "код завершился с ошибкой"}`;
  }
  const list = kinds.join(", ") || "неизвестно";
  if (status === "blocked") {
    return `[CAPABILITY DENIED]: выполнение остановлено; запрошены: ${list} (${String(capabilities.length)}).`;
  }
  return `[CAPABILITY DENIED]: код запросил: ${list} (${String(capabilities.length)}).`;
}

/** Runs a JS/ESM file in an instrumented vm sandbox and reports every capability it reaches for. */
export function runCuckoo(cwd: string, file: string, options: CuckooOptions = {}): CuckooReport {
  const absolute = resolve(cwd, file);
  if (!existsSync(absolute)) {
    throw new PilotError(`Файл не найден: ${file}`, { exitCode: 2 });
  }
  const stats = statSync(absolute);
  if (!stats.isFile() || stats.size > MAX_FILE_BYTES) {
    throw new PilotError("Cuckoo принимает один JS/ESM-файл до 1 МБ", { exitCode: 2 });
  }

  const timeoutMs = Math.max(100, Math.min(60_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cuckoo-"));
  const worker = join(dir, "worker.cjs");
  const payload = join(dir, "payload.json");
  writeFileSync(worker, WORKER, "utf8");
  writeFileSync(
    payload,
    JSON.stringify({ file: absolute, scriptTimeoutMs: timeoutMs }),
    "utf8",
  );

  try {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_V8_COVERAGE: "" };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [worker, payload], {
      cwd,
      env,
      encoding: "utf8",
      timeout: timeoutMs + 60_000,
      killSignal: "SIGKILL",
      maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      const report: CuckooReport = {
        status: "timeout",
        file,
        capabilities: [],
        output: [],
        summary: renderSummary("timeout", []),
        content: "",
      };
      report.content = renderCuckoo(report);
      return report;
    }
    if (result.status !== 0) {
      const report: CuckooReport = {
        status: "error",
        file,
        capabilities: [],
        output: [],
        error: cap(result.stderr.trim() || result.stdout.trim() || "worker failed"),
        summary: "",
        content: "",
      };
      report.summary = renderSummary("error", [], report.error);
      report.content = renderCuckoo(report);
      return report;
    }

    let parsed: {
      status?: CuckooStatus;
      capabilities?: CuckooCapability[];
      output?: string[];
      error?: string;
    };
    try {
      parsed = JSON.parse(result.stdout.trim()) as typeof parsed;
    } catch {
      const report: CuckooReport = {
        status: "error",
        file,
        capabilities: [],
        output: [],
        error: "worker вернул не JSON",
        summary: "",
        content: "",
      };
      report.summary = renderSummary("error", [], report.error);
      report.content = renderCuckoo(report);
      return report;
    }

    const capabilities = Array.isArray(parsed.capabilities)
      ? parsed.capabilities.filter(
          (item): item is CuckooCapability =>
            Boolean(item) && typeof item.kind === "string" && typeof item.detail === "string",
        )
      : [];
    const status: CuckooStatus =
      parsed.status === "clean" ||
      parsed.status === "capabilities" ||
      parsed.status === "blocked" ||
      parsed.status === "timeout" ||
      parsed.status === "error"
        ? parsed.status
        : "error";
    const report: CuckooReport = {
      status,
      file,
      capabilities,
      output: Array.isArray(parsed.output)
        ? parsed.output.filter((line): line is string => typeof line === "string").slice(0, 60)
        : [],
      error: typeof parsed.error === "string" ? parsed.error : undefined,
      summary: renderSummary(status, capabilities, parsed.error),
      content: "",
    };
    report.content = renderCuckoo(report);
    return report;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function renderCuckoo(report: CuckooReport): string {
  const lines = [
    `Cuckoo: ${report.status}`,
    `File: ${report.file}`,
    `Capabilities: ${String(report.capabilities.length)}`,
  ];
  for (const capability of report.capabilities) {
    lines.push(`  ${capability.kind}: ${capability.detail}`);
  }
  if (report.output.length > 0) {
    lines.push("Output:");
    for (const line of report.output) lines.push(`  ${line}`);
  }
  if (report.error) lines.push(`Error: ${report.error}`);
  lines.push("", report.summary);
  return `${lines.join("\n")}\n`;
}
