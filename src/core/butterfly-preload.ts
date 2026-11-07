import { appendFileSync } from "node:fs";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";

interface ButterflyConfig {
  seed: number;
  failRate: number;
  latencyRate: number;
  latencyMs: number;
  brokenJsonRate: number;
  fsFailRate: number;
  dbFailRate: number;
  scope: string[];
}

const CONFIG_ENV = "OC_PILOT_BUTTERFLY";
const LOG_ENV = "OC_PILOT_BUTTERFLY_LOG";

function numberOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseConfig(): ButterflyConfig | undefined {
  const raw = process.env[CONFIG_ENV];
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<ButterflyConfig>;
    const scope = Array.isArray(parsed.scope)
      ? parsed.scope.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [];
    return {
      seed: numberOr(parsed.seed, 42),
      failRate: Math.max(0, Math.min(1, numberOr(parsed.failRate, 0.1))),
      latencyRate: Math.max(0, Math.min(1, numberOr(parsed.latencyRate, 0.05))),
      latencyMs: Math.max(0, numberOr(parsed.latencyMs, 3000)),
      brokenJsonRate: Math.max(0, Math.min(1, numberOr(parsed.brokenJsonRate, 0.02))),
      fsFailRate: Math.max(0, Math.min(1, numberOr(parsed.fsFailRate, 0.05))),
      dbFailRate: Math.max(0, Math.min(1, numberOr(parsed.dbFailRate, 0.05))),
      scope: scope.length > 0 ? scope : ["src/"],
    };
  } catch {
    return undefined;
  }
}

const config = parseConfig();

if (config) {
  const logPath = process.env[LOG_ENV];
  let state = config.seed >>> 0;

  const random = (): number => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };

  const maybe = (rate: number): boolean => rate > 0 && random() < rate;

  const log = (type: string, target: string): void => {
    if (!logPath) return;
    try {
      appendFileSync(logPath, `${JSON.stringify({ type, target, seed: config.seed })}\n`, "utf8");
    } catch {
      // Logging must never change the test result.
    }
  };

  const scope = config.scope.map((entry) => entry.replace(/\\/g, "/"));
  const callerInScope = (): boolean => {
    if (scope.length === 0) return true;
    const stack = (new Error().stack ?? "").replace(/\\/g, "/");
    return scope.some((entry) => stack.includes(entry));
  };

  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === "function") {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (!callerInScope()) return originalFetch(input, init);
      const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const roll = random();
      if (roll < config.failRate) {
        log("http500", target);
        return new Response("butterfly injected 500", {
          status: 500,
          statusText: "Butterfly 500",
          headers: { "content-type": "text/plain" },
        });
      }
      if (roll < config.failRate + config.latencyRate) {
        log("latency", target);
        await delay(config.latencyMs);
      }
      if (maybe(config.brokenJsonRate)) {
        log("brokenJson", target);
        return new Response('{"butterfly":', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch;
  }

  const fsAny = fs as unknown as Record<string, unknown>;
  const promises = fs.promises as unknown as Record<string, unknown>;

  const fault = (target: string): NodeJS.ErrnoException => {
    log("fsError", target);
    const error = new Error(`ButterflyError: filesystem fault injected for ${target}`) as NodeJS.ErrnoException;
    error.code = "EIO";
    return error;
  };

  const wrapSync = (name: string): void => {
    const original = fsAny[name];
    if (typeof original !== "function") return;
    fsAny[name] = function (this: unknown, ...args: unknown[]): unknown {
      if (callerInScope() && maybe(config.fsFailRate)) throw fault(name);
      return (original as (...values: unknown[]) => unknown).apply(this, args);
    };
  };

  const wrapCallback = (name: string): void => {
    const original = fsAny[name];
    if (typeof original !== "function") return;
    fsAny[name] = function (this: unknown, ...args: unknown[]): unknown {
      if (callerInScope() && maybe(config.fsFailRate)) {
        const error = fault(name);
        const callback = args[args.length - 1];
        if (typeof callback === "function") {
          queueMicrotask(() => (callback as (value: unknown) => void)(error));
          return undefined;
        }
        throw error;
      }
      return (original as (...values: unknown[]) => unknown).apply(this, args);
    };
  };

  const wrapPromise = (name: string): void => {
    const original = promises[name];
    if (typeof original !== "function") return;
    promises[name] = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
      if (callerInScope() && maybe(config.fsFailRate)) throw fault(`fs.promises.${name}`);
      return (original as (...values: unknown[]) => unknown).apply(this, args);
    };
  };

  for (const name of ["readFileSync", "writeFileSync", "appendFileSync", "openSync", "statSync", "lstatSync", "accessSync", "readdirSync"]) {
    wrapSync(name);
  }
  for (const name of ["readFile", "writeFile", "appendFile", "open", "stat", "lstat", "access", "readdir"]) {
    wrapCallback(name);
  }
  for (const name of ["readFile", "writeFile", "appendFile", "open", "stat", "lstat", "access", "readdir"]) {
    wrapPromise(name);
  }
  syncBuiltinESMExports();

  const require = createRequire(import.meta.url);
  const wrapDb = (prototype: unknown, method: string): void => {
    if (!prototype || typeof prototype !== "object") return;
    const record = prototype as Record<string, unknown>;
    const original = record[method];
    if (typeof original !== "function") return;
    record[method] = function (this: unknown, ...args: unknown[]): unknown {
      if (callerInScope() && maybe(config.dbFailRate)) {
        log("dbError", method);
        const error = new Error(`ButterflyError: database fault injected in ${method}`);
        const callback = args[args.length - 1];
        if (typeof callback === "function") {
          queueMicrotask(() => (callback as (value: unknown) => void)(error));
          return undefined;
        }
        return Promise.reject(error);
      }
      return (original as (...values: unknown[]) => unknown).apply(this, args);
    };
  };

  for (const [moduleName, prototypeNames] of [
    ["pg", ["Client", "Pool"]],
    ["mysql2", ["Connection", "Pool"]],
    ["mysql2/promise", ["Connection", "Pool"]],
  ] as const) {
    try {
      const module = require(moduleName) as Record<string, unknown>;
      for (const prototypeName of prototypeNames) {
        const constructor = module[prototypeName] as { prototype?: unknown } | undefined;
        wrapDb(constructor?.prototype, "query");
        wrapDb(constructor?.prototype, "execute");
      }
    } catch {
      // Optional database drivers are best-effort only.
    }
  }
}
