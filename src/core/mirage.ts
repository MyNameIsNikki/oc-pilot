import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runShellCommand } from "./command.js";
import { PilotError } from "./errors.js";

export interface MirageEntry {
  kind: "fetch";
  method: string;
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface MirageCassette {
  version: 1;
  createdAt: string;
  entries: MirageEntry[];
  clock: number[];
}

export type MirageMode = "record" | "replay";
export type MirageStatus = "ok" | "miss" | "error";

export interface MirageReport {
  mode: MirageMode;
  cassette: string;
  status: MirageStatus;
  entries: number;
  clock: number;
  exitCode: number;
  output: string;
  summary: string;
  content: string;
}

export interface MirageOptions {
  mode: MirageMode;
  command: string;
  cassette: string;
  timeoutMs?: number;
}

export const MIRAGE_DIR = ".oc-pilot/mirage";
const DEFAULT_TIMEOUT_MS = 300_000;

const PRELOAD = String.raw`
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const mode = process.env.MIRAGE_MODE;
const cassettePath = process.env.MIRAGE_CASSETTE;
const cassette = mode === "replay"
  ? JSON.parse(readFileSync(cassettePath, "utf8"))
  : { version: 1, createdAt: new Date().toISOString(), entries: [], clock: [] };
const realFetch = globalThis.fetch;
const RealDate = Date;
let clockIndex = 0;
const nextClock = (real) => {
  if (mode === "record") {
    cassette.clock.push(real);
    return real;
  }
  const value = cassette.clock[clockIndex];
  clockIndex += 1;
  return value === undefined ? (cassette.clock[cassette.clock.length - 1] ?? real) : value;
};
if (mode === "record") {
  globalThis.fetch = async (input, init) => {
    const response = await realFetch(input, init);
    const body = await response.clone().text();
    const url = typeof input === "string" ? input : input.url;
    const method = String((init && init.method) || "GET").toUpperCase();
    cassette.entries.push({
      kind: "fetch",
      method,
      url,
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body
    });
    return response;
  };
} else {
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const method = String((init && init.method) || "GET").toUpperCase();
    const entry = cassette.entries.find((item) => item.method === method && item.url === url && !item.used);
    if (!entry) {
      process.exitCode = 86;
      const error = new Error("MIRAGE MISS: " + method + " " + url);
      error.mirage = true;
      throw error;
    }
    entry.used = true;
    return new Response(entry.body, { status: entry.status, headers: entry.headers });
  };
}
class MirageDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(nextClock(RealDate.now()));
    else super(...args);
  }
  static now() {
    return nextClock(RealDate.now());
  }
}
globalThis.Date = MirageDate;
if (mode === "record") {
  process.on("exit", () => {
    mkdirSync(dirname(cassettePath), { recursive: true });
    writeFileSync(cassettePath, JSON.stringify(cassette, null, 2));
  });
}
`;

function cap(output: string): string {
  return output.length > 4_000 ? output.slice(-4_000) : output;
}

export function miragePath(cwd: string, cassette: string): string {
  return resolve(cwd, cassette);
}

export function readCassette(path: string): MirageCassette | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<MirageCassette>;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries) || !Array.isArray(parsed.clock)) return undefined;
    return parsed as MirageCassette;
  } catch {
    return undefined;
  }
}

/** Runs a command with fetch/Date recorded or replayed from a cassette. */
export async function runMirage(cwd: string, options: MirageOptions): Promise<MirageReport> {
  const cassettePath = miragePath(cwd, options.cassette);
  if (options.mode === "replay" && !existsSync(cassettePath)) {
    throw new PilotError(`Кассета не найдена: ${options.cassette}`, {
      hint: "Сначала запишите её: oc-pilot mirage record.",
      exitCode: 2,
    });
  }
  mkdirSync(dirname(cassettePath), { recursive: true });

  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-mirage-"));
  const preload = join(dir, "preload.mjs");
  writeFileSync(preload, PRELOAD, "utf8");

  try {
    const existing = process.env.NODE_OPTIONS?.trim();
    const nodeOptions = `${existing ? `${existing} ` : ""}--import ${pathToFileURL(preload).href}`;
    const result = await runShellCommand(options.command, cwd, {
      timeoutMs: Math.max(1_000, Math.min(900_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
      env: {
        MIRAGE_MODE: options.mode,
        MIRAGE_CASSETTE: cassettePath,
        NODE_OPTIONS: nodeOptions,
      },
    });

    const cassette = readCassette(cassettePath);
    const entries = cassette?.entries.length ?? 0;
    const clock = cassette?.clock.length ?? 0;
    const miss = result.exitCode === 86 || /MIRAGE MISS/.test(result.output);
    const status: MirageStatus = miss ? "miss" : result.exitCode === 0 ? "ok" : "error";
    const summary =
      status === "miss"
        ? `[MIRAGE MISS]: ${options.mode} не нашёл запись для запроса; кассета ${options.cassette}.`
        : status === "error"
          ? `[MIRAGE ERROR]: команда завершилась с кодом ${String(result.exitCode)}.`
          : options.mode === "record"
            ? `[MIRAGE RECORDED]: ${String(entries)} fetch, ${String(clock)} clock -> ${options.cassette}.`
            : `[MIRAGE REPLAYED]: ${String(entries)} fetch, ${String(clock)} clock.`;
    const lines = [
      `Mirage: ${options.mode} ${status}`,
      `Cassette: ${options.cassette}`,
      `Entries: ${String(entries)}, clock: ${String(clock)}`,
      `Exit: ${String(result.exitCode)}`,
    ];
    if (status !== "ok") {
      lines.push("Output:");
      lines.push(cap(result.output).trimEnd());
    }
    lines.push("", summary);
    return {
      mode: options.mode,
      cassette: options.cassette,
      status,
      entries,
      clock,
      exitCode: result.exitCode,
      output: cap(result.output),
      summary,
      content: `${lines.join("\n")}\n`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface MirageCassetteInfo {
  file: string;
  entries: number;
  clock: number;
  createdAt?: string;
}

export function listCassettes(cwd: string): MirageCassetteInfo[] {
  const dir = join(cwd, MIRAGE_DIR);
  if (!existsSync(dir)) return [];
  const result: MirageCassetteInfo[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const path = join(dir, entry);
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    const cassette = readCassette(path);
    result.push({
      file: `${MIRAGE_DIR}/${basename(entry)}`,
      entries: cassette?.entries.length ?? 0,
      clock: cassette?.clock.length ?? 0,
      createdAt: cassette?.createdAt,
    });
  }
  return result.sort((left, right) => left.file.localeCompare(right.file));
}

export function clearMirage(cwd: string): { removed: number } {
  const dir = join(cwd, MIRAGE_DIR);
  if (!existsSync(dir)) return { removed: 0 };
  const removed = listCassettes(cwd).length;
  rmSync(dir, { recursive: true, force: true });
  return { removed };
}
