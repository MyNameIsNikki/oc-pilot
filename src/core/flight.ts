import { spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { PilotError } from "./errors.js";
import { getRepoRoot, runGit } from "./git.js";

export type FlightEventKind =
  | "session.start"
  | "command.start"
  | "command.end"
  | "file.checkpoint"
  | "gate.result"
  | "approval"
  | "session.end";

export interface FlightEvent {
  seq: number;
  ts: string;
  kind: FlightEventKind;
  prev: string;
  hash: string;
  payload: Record<string, unknown>;
}

export interface FlightMeta {
  id: string;
  name: string;
  startedAt: string;
  cwd: string;
  baseCommit: string | null;
  branch: string | null;
}

export interface FlightSession {
  dir: string;
  meta: FlightMeta;
  events: FlightEvent[];
}

export interface FlightCheckpoint {
  label: string;
  tree: string;
  commit: string;
  createdAt: string;
}

export interface FlightVerifyResult {
  valid: boolean;
  events: number;
  errors: string[];
}

export interface FlightAuditEntry {
  id: string;
  name: string;
  valid: boolean;
  events: number;
  errors: string[];
}

export interface FlightAuditResult {
  total: number;
  valid: number;
  tampered: number;
  flights: FlightAuditEntry[];
}

export interface FlightStatus {
  active: boolean;
  session?: FlightSession;
  checkpoints?: number;
  commands?: number;
  lastEvent?: FlightEvent;
}

export interface FlightListEntry extends FlightMeta {
  events: number;
  checkpoints: number;
  ended: boolean;
}

export interface FlightCommandStat {
  command: string;
  runs: number;
  failures: number;
}

export interface FlightStats {
  total: number;
  active: number;
  ended: number;
  events: number;
  commands: number;
  checkpoints: number;
  failedCommands: number;
  durationMs: number;
  averageDurationMs: number;
  topCommands: FlightCommandStat[];
}

export interface FlightPruneOptions {
  keep?: number;
  olderThanDays?: number;
  dryRun?: boolean;
}

export interface FlightPruneResult {
  removed: string[];
  kept: number;
  active: string | null;
  dryRun: boolean;
}

export interface FlightShow {
  meta: FlightMeta;
  events: FlightEvent[];
  verification: FlightVerifyResult;
}

export interface FlightExecResult {
  command: string[];
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
  stdoutTail: string;
  stderrTail: string;
  eventStart: FlightEvent;
  eventEnd: FlightEvent;
}

const MAX_TAIL = 8000;

function isAbsoluteLike(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(value);
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function flightEventHash(event: Omit<FlightEvent, "hash">): string {
  return `sha256:${createHash("sha256").update(canonicalJson(event)).digest("hex")}`;
}

export function flightsRoot(cwd: string): string {
  const repoRoot = getRepoRoot(cwd);
  const result = runGit(["rev-parse", "--git-dir"], repoRoot);
  if (result.status !== 0) {
    throw new PilotError("Не удалось найти git-каталог для полёта.", {
      hint: "Запустите команду внутри git-репозитория.",
    });
  }
  const value = result.stdout.trim();
  const gitDir = isAbsoluteLike(value) || isAbsolute(value) ? value : resolve(repoRoot, value);
  return join(gitDir, "oc-pilot", "flights");
}

export function newFlightId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

function sessionDir(root: string, id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") {
    throw new PilotError(`Некорректный идентификатор полёта: ${id}`, {
      hint: "Используйте идентификатор из oc-pilot flight list.",
    });
  }
  return join(root, id);
}

function metaPath(dir: string): string {
  return join(dir, "meta.json");
}

function eventsPath(dir: string): string {
  return join(dir, "events.jsonl");
}

function currentPath(root: string): string {
  return join(root, "current");
}

function readMeta(dir: string): FlightMeta {
  const text = readFileSync(metaPath(dir), "utf8");
  return JSON.parse(text) as FlightMeta;
}

function writeMeta(dir: string, meta: FlightMeta): void {
  writeFileSync(metaPath(dir), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

export function readFlightEvents(dir: string): FlightEvent[] {
  const file = eventsPath(dir);
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  const events: FlightEvent[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let event: FlightEvent;
    try {
      event = JSON.parse(line) as FlightEvent;
    } catch {
      throw new PilotError(`Повреждён журнал полёта: строка ${index + 1}.`, {
        hint: "Журнал нельзя прочитать; проверьте events.jsonl вручную.",
      });
    }
    events.push(event);
  }
  return events;
}

export function appendFlightEvent(
  dir: string,
  kind: FlightEventKind,
  payload: Record<string, unknown>,
): FlightEvent {
  const events = readFlightEvents(dir);
  const last = events.at(-1);
  const base = {
    seq: (last?.seq ?? 0) + 1,
    ts: new Date().toISOString(),
    kind,
    prev: last?.hash ?? "genesis",
    payload,
  };
  const event: FlightEvent = { ...base, hash: flightEventHash(base) };
  appendFileSync(eventsPath(dir), `${JSON.stringify(event)}\n`, "utf8");
  return event;
}

export function verifyFlightEvents(events: FlightEvent[]): FlightVerifyResult {
  const errors: string[] = [];
  let previous = "genesis";
  for (const [index, event] of events.entries()) {
    if (event.seq !== index + 1) {
      errors.push(`Событие ${index + 1}: ожидался seq ${index + 1}, получен ${event.seq}.`);
    }
    if (event.prev !== previous) {
      errors.push(`Событие ${index + 1}: разорвана цепочка prev.`);
    }
    const { hash, ...rest } = event;
    if (flightEventHash(rest) !== hash) {
      errors.push(`Событие ${index + 1}: хеш не совпадает.`);
    }
    previous = event.hash;
  }
  if (events.length === 0) errors.push("Журнал пуст.");
  return { valid: errors.length === 0, events: events.length, errors };
}

export function startFlight(cwd: string, name: string): FlightSession {
  const root = flightsRoot(cwd);
  mkdirSync(root, { recursive: true });
  const current = currentPath(root);
  if (existsSync(current)) {
    const existingId = readFileSync(current, "utf8").trim();
    if (existingId && existsSync(sessionDir(root, existingId))) {
      throw new PilotError(`Уже идёт полёт ${existingId}.`, {
        hint: "Завершите его: oc-pilot flight end.",
      });
    }
    rmSync(current, { force: true });
  }
  const repoRoot = getRepoRoot(cwd);
  const id = newFlightId();
  const dir = sessionDir(root, id);
  mkdirSync(dir, { recursive: true });
  const head = runGit(["rev-parse", "--verify", "HEAD"], repoRoot);
  const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
  const meta: FlightMeta = {
    id,
    name,
    startedAt: new Date().toISOString(),
    cwd: repoRoot,
    baseCommit: head.status === 0 ? head.stdout.trim() : null,
    branch: branch.status === 0 ? branch.stdout.trim() : null,
  };
  writeMeta(dir, meta);
  appendFlightEvent(dir, "session.start", {
    name,
    cwd: meta.cwd,
    baseCommit: meta.baseCommit,
    branch: meta.branch,
  });
  writeFileSync(current, `${id}\n`, "utf8");
  return { dir, meta, events: readFlightEvents(dir) };
}

export function activeFlight(cwd: string): FlightSession | undefined {
  const root = flightsRoot(cwd);
  const current = currentPath(root);
  if (!existsSync(current)) return undefined;
  const id = readFileSync(current, "utf8").trim();
  if (!id) return undefined;
  const dir = sessionDir(root, id);
  if (!existsSync(metaPath(dir))) return undefined;
  const meta = readMeta(dir);
  return { dir, meta, events: readFlightEvents(dir) };
}

export function requireActiveFlight(cwd: string): FlightSession {
  const session = activeFlight(cwd);
  if (!session) {
    throw new PilotError("Полёт не запущен.", {
      hint: "Начните: oc-pilot flight start --name \"...\".",
    });
  }
  return session;
}

function runGitWithEnv(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function createCheckpoint(cwd: string, label: string): FlightCheckpoint {
  const session = requireActiveFlight(cwd);
  const repoRoot = getRepoRoot(cwd);
  const indexFile = join(session.dir, `index-${randomBytes(4).toString("hex")}.tmp`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_INDEX_FILE: indexFile,
    GIT_AUTHOR_NAME: "oc-pilot flight",
    GIT_AUTHOR_EMAIL: "flight@oc-pilot.local",
    GIT_COMMITTER_NAME: "oc-pilot flight",
    GIT_COMMITTER_EMAIL: "flight@oc-pilot.local",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
  };
  try {
    const added = runGitWithEnv(["add", "-A"], repoRoot, env);
    if (added.status !== 0) {
      throw new PilotError("Не удалось подготовить снимок рабочего дерева.", {
        hint: added.stderr.trim() || "Проверьте состояние git-индекса.",
      });
    }
    const treeResult = runGitWithEnv(["write-tree"], repoRoot, env);
    if (treeResult.status !== 0) {
      throw new PilotError("Не удалось записать дерево снимка.", {
        hint: treeResult.stderr.trim() || "Проверьте git-репозиторий.",
      });
    }
    const tree = treeResult.stdout.trim();
    const head = runGit(["rev-parse", "--verify", "HEAD"], repoRoot);
    const args = ["commit-tree", tree];
    if (head.status === 0) args.push("-p", head.stdout.trim());
    args.push("-m", `oc-pilot flight checkpoint: ${label}`);
    const commitResult = runGitWithEnv(args, repoRoot, env);
    if (commitResult.status !== 0) {
      throw new PilotError("Не удалось создать снимок полёта.", {
        hint: commitResult.stderr.trim() || "Проверьте git-репозиторий.",
      });
    }
    const checkpoint: FlightCheckpoint = {
      label,
      tree,
      commit: commitResult.stdout.trim(),
      createdAt: new Date().toISOString(),
    };
    appendFlightEvent(session.dir, "file.checkpoint", { ...checkpoint });
    return checkpoint;
  } finally {
    rmSync(indexFile, { force: true });
  }
}

function tail(value: string): string {
  if (value.length <= MAX_TAIL) return value;
  return value.slice(-MAX_TAIL);
}

export function execInFlight(
  cwd: string,
  command: string[],
  options: { timeoutMs?: number; quiet?: boolean } = {},
): FlightExecResult {
  const session = requireActiveFlight(cwd);
  if (command.length === 0) {
    throw new PilotError("Не указана команда для flight exec.", {
      hint: "Используйте: oc-pilot flight exec -- npm test.",
    });
  }
  const timeoutMs = options.timeoutMs ?? 600_000;
  const started = Date.now();
  const eventStart = appendFlightEvent(session.dir, "command.start", { command, timeoutMs });
  const result = spawnSync(command[0] as string, command.slice(1), {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  const durationMs = Date.now() - started;
  const timedOut =
    result.signal === "SIGTERM" ||
    (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  const exitCode = result.status;
  const stdoutTail = tail(result.stdout ?? "");
  const stderrTail = tail(result.stderr ?? "");
  const eventEnd = appendFlightEvent(session.dir, "command.end", {
    command,
    exitCode,
    signal: result.signal,
    durationMs,
    timedOut,
    stdoutTail,
    stderrTail,
    error: result.error ? String(result.error.message) : undefined,
  });
  if (!options.quiet) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  return {
    command,
    exitCode,
    signal: result.signal,
    durationMs,
    timedOut,
    stdoutTail,
    stderrTail,
    eventStart,
    eventEnd,
  };
}

export function endFlight(cwd: string): { meta: FlightMeta; events: FlightEvent[]; summary: Record<string, unknown> } {
  const session = requireActiveFlight(cwd);
  const checkpoints = session.events.filter((event) => event.kind === "file.checkpoint").length;
  const commands = session.events.filter((event) => event.kind === "command.start").length;
  const summary = {
    checkpoints,
    commands,
    durationMs: Date.now() - Date.parse(session.meta.startedAt),
  };
  appendFlightEvent(session.dir, "session.end", summary);
  rmSync(currentPath(flightsRoot(cwd)), { force: true });
  const events = readFlightEvents(session.dir);
  return { meta: session.meta, events, summary };
}

export function listFlights(cwd: string): FlightListEntry[] {
  const root = flightsRoot(cwd);
  if (!existsSync(root)) return [];
  const entries: FlightListEntry[] = [];
  for (const name of readdirSync(root)) {
    const dir = sessionDir(root, name);
    if (!existsSync(metaPath(dir))) continue;
    const meta = readMeta(dir);
    const events = readFlightEvents(dir);
    entries.push({
      ...meta,
      events: events.length,
      checkpoints: events.filter((event) => event.kind === "file.checkpoint").length,
      ended: events.some((event) => event.kind === "session.end"),
    });
  }
  return entries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function flightStats(cwd: string): FlightStats {
  const flights = listFlights(cwd);
  const commands = new Map<string, FlightCommandStat>();
  let events = 0;
  let commandCount = 0;
  let checkpoints = 0;
  let failedCommands = 0;
  let durationMs = 0;
  for (const entry of flights) {
    const show = showFlight(cwd, entry.id);
    events += show.events.length;
    checkpoints += entry.checkpoints;
    const startedAt = Date.parse(show.meta.startedAt);
    const endedAt = Date.parse(show.events.at(-1)?.ts ?? show.meta.startedAt);
    durationMs += Math.max(0, endedAt - startedAt);
    for (const event of show.events) {
      if (event.kind === "command.start") commandCount += 1;
      if (event.kind !== "command.end") continue;
      const payload = event.payload as Record<string, unknown>;
      const command = Array.isArray(payload.command)
        ? payload.command.filter((part): part is string => typeof part === "string")
        : [];
      if (command.length === 0) continue;
      const key = JSON.stringify(command);
      const current = commands.get(key) ?? { command: command.join(" "), runs: 0, failures: 0 };
      current.runs += 1;
      if (
        payload.timedOut === true ||
        (typeof payload.exitCode === "number" && payload.exitCode !== 0)
      ) {
        current.failures += 1;
        failedCommands += 1;
      }
      commands.set(key, current);
    }
  }
  const topCommands = [...commands.values()]
    .sort((left, right) => right.runs - left.runs || left.command.localeCompare(right.command))
    .slice(0, 5);
  return {
    total: flights.length,
    active: flights.filter((flight) => !flight.ended).length,
    ended: flights.filter((flight) => flight.ended).length,
    events,
    commands: commandCount,
    checkpoints,
    failedCommands,
    durationMs,
    averageDurationMs: flights.length === 0 ? 0 : Math.round(durationMs / flights.length),
    topCommands,
  };
}

export function pruneFlights(cwd: string, options: FlightPruneOptions = {}): FlightPruneResult {
  const keep = options.keep ?? 20;
  if (!Number.isInteger(keep) || keep < 0) {
    throw new PilotError(`Некорректный --keep: ${String(options.keep)}`, {
      hint: "Укажите неотрицательное целое число полётов, которые нужно оставить.",
    });
  }
  const days = options.olderThanDays;
  if (days !== undefined && (!Number.isFinite(days) || days < 0)) {
    throw new PilotError(`Некорректный --older-than: ${String(days)}`, {
      hint: "Укажите неотрицательное число дней.",
    });
  }
  const active = activeFlight(cwd)?.meta.id ?? null;
  const cutoff = days === undefined ? undefined : Date.now() - days * 86_400_000;
  const flights = listFlights(cwd);
  const ended = flights.filter((flight) => flight.ended && flight.id !== active);
  const remove = new Set<string>();
  ended.forEach((flight, index) => {
    if (index < keep) return;
    if (cutoff !== undefined && Date.parse(flight.startedAt) >= cutoff) return;
    remove.add(flight.id);
  });
  const removed: string[] = [];
  const root = flightsRoot(cwd);
  for (const id of remove) {
    removed.push(id);
    if (options.dryRun !== true) rmSync(sessionDir(root, id), { recursive: true, force: true });
  }
  return {
    removed,
    kept: flights.length - removed.length,
    active,
    dryRun: options.dryRun === true,
  };
}

export function showFlight(cwd: string, id: string): FlightShow {
  const root = flightsRoot(cwd);
  const dir = sessionDir(root, id);
  if (!existsSync(metaPath(dir))) {
    throw new PilotError(`Полёт ${id} не найден.`, {
      hint: "Посмотрите список: oc-pilot flight list.",
    });
  }
  const meta = readMeta(dir);
  const events = readFlightEvents(dir);
  return { meta, events, verification: verifyFlightEvents(events) };
}

export function flightStatus(cwd: string): FlightStatus {
  const session = activeFlight(cwd);
  if (!session) return { active: false };
  const checkpoints = session.events.filter((event) => event.kind === "file.checkpoint").length;
  const commands = session.events.filter((event) => event.kind === "command.start").length;
  return {
    active: true,
    session,
    checkpoints,
    commands,
    lastEvent: session.events.at(-1),
  };
}

export function renderFlightStatus(status: FlightStatus): string {
  if (!status.active || !status.session) {
    return "Полёт не запущен. Начните: oc-pilot flight start --name \"...\".";
  }
  const { meta } = status.session;
  return [
    `Полёт ${meta.id} (${meta.name})`,
    `Начат: ${meta.startedAt}`,
    `Коммит: ${meta.baseCommit ?? "нет HEAD"}`,
    `Событий: ${status.session.events.length}; чекпоинтов: ${status.checkpoints ?? 0}; команд: ${status.commands ?? 0}`,
    `Последнее событие: ${status.lastEvent?.kind ?? "нет"}`,
  ].join("\n");
}

export function renderFlightList(flights: FlightListEntry[]): string {
  if (flights.length === 0) return "Полётов пока нет.";
  return flights
    .map(
      (flight) =>
        `${flight.id}  ${flight.ended ? "завершён" : "активен"}  ${flight.name}  событий ${flight.events}, чекпоинтов ${flight.checkpoints}`,
    )
    .join("\n");
}

export function renderFlightStats(stats: FlightStats): string {
  if (stats.total === 0) return "[FLIGHT STATS] полётов нет.";
  const lines = [
    `[FLIGHT STATS] всего ${stats.total}: завершено ${stats.ended}, активно ${stats.active}.`,
    `События: ${stats.events}, команды: ${stats.commands}, чекпоинты: ${stats.checkpoints}, ошибки команд: ${stats.failedCommands}.`,
    `Длительность: ${stats.durationMs} мс, средняя: ${stats.averageDurationMs} мс.`,
  ];
  if (stats.topCommands.length > 0) {
    lines.push("Частые команды:");
    for (const command of stats.topCommands) {
      lines.push(`  ${command.command} — ${command.runs}, ошибок ${command.failures}`);
    }
  }
  return lines.join("\n");
}

export function renderFlightStatsHtml(stats: FlightStats): string {
  const cards = [
    ["Flights", stats.total],
    ["Ended", stats.ended],
    ["Active", stats.active],
    ["Events", stats.events],
    ["Commands", stats.commands],
    ["Checkpoints", stats.checkpoints],
    ["Failed commands", stats.failedCommands],
    ["Duration", `${stats.durationMs} ms`],
    ["Average duration", `${stats.averageDurationMs} ms`],
  ]
    .map(
      ([label, value]) =>
        `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`,
    )
    .join("");
  const commands =
    stats.topCommands.length === 0
      ? `<p class="muted">No commands recorded yet.</p>`
      : `<table><thead><tr><th>Command</th><th>Runs</th><th>Failures</th></tr></thead><tbody>${stats.topCommands
          .map(
            (command) =>
              `<tr><td><code>${escapeHtml(command.command)}</code></td><td>${command.runs}</td><td>${command.failures}</td></tr>`,
          )
          .join("")}</tbody></table>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>oc-pilot flight stats</title>
<style>
:root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --ink:#17191d; --muted:#68707d; --line:#d9dde4; --accent:#2457d6; }
@media (prefers-color-scheme: dark) { :root { --bg:#111318; --card:#181b22; --ink:#e8ebf0; --muted:#9aa3b1; --line:#2b303a; --accent:#8ab4ff; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width:1080px; margin:0 auto; padding:40px 20px 64px; }
h1 { margin:0 0 20px; font-size:clamp(28px,5vw,44px); line-height:1.1; }
.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; margin:20px 0; }
.grid > div, section { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; }
.grid span { display:block; color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.06em; }
.grid strong { display:block; margin-top:4px; font-size:20px; }
section { margin:18px 0; }
h2 { margin:0 0 12px; font-size:18px; }
table { width:100%; border-collapse:collapse; }
th, td { padding:8px; border-top:1px solid var(--line); text-align:left; }
th { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.06em; }
code { font-family:ui-monospace, SFMono-Regular, Consolas, monospace; }
.muted { color:var(--muted); }
</style>
</head>
<body>
<main>
<h1>oc-pilot flight stats</h1>
<div class="grid">${cards}</div>
<section><h2>Top commands</h2>${commands}</section>
</main>
</body>
</html>`;
}

export function renderFlightPrune(result: FlightPruneResult): string {
  const shown = result.removed.slice(0, 5).join(", ");
  const suffix = result.removed.length > 5 ? ` и ещё ${result.removed.length - 5}` : "";
  const list = result.removed.length > 0 ? `: ${shown}${suffix}` : "";
  return `[FLIGHT PRUNE] ${result.dryRun ? "будет удалено" : "удалено"} ${result.removed.length}${list}; осталось ${result.kept}${result.active ? `, активный ${result.active}` : ""}.`;
}

function eventSummary(event: FlightEvent): string {
  if (event.kind === "file.checkpoint") {
    return `чекпоинт ${String(event.payload.label ?? "")} (${String(event.payload.commit ?? "").slice(0, 8)})`;
  }
  if (event.kind === "command.start" || event.kind === "command.end") {
    const command = Array.isArray(event.payload.command) ? event.payload.command.join(" ") : "";
    return `${command}${event.kind === "command.end" ? ` → ${String(event.payload.exitCode ?? "?")}` : ""}`;
  }
  return String(event.payload.name ?? event.kind);
}

export function renderFlightShow(show: FlightShow): string {
  const lines = [
    `Полёт ${show.meta.id} (${show.meta.name})`,
    `Начат: ${show.meta.startedAt}`,
    `Коммит: ${show.meta.baseCommit ?? "нет HEAD"}`,
    `Проверка: ${show.verification.valid ? "цепочка цела" : "цепочка повреждена"}`,
    `Событий: ${show.events.length}`,
    "",
    ...show.events.map((event) => `${String(event.seq).padStart(3, " ")}  ${event.kind}  ${eventSummary(event)}`),
  ];
  if (!show.verification.valid) lines.push("", ...show.verification.errors.map((error) => `! ${error}`));
  return lines.join("\n");
}

export function auditFlights(cwd: string): FlightAuditResult {
  const flights: FlightAuditEntry[] = [];
  for (const entry of listFlights(cwd)) {
    const show = showFlight(cwd, entry.id);
    flights.push({
      id: show.meta.id,
      name: show.meta.name,
      valid: show.verification.valid,
      events: show.verification.events,
      errors: show.verification.errors,
    });
  }
  const tampered = flights.filter((flight) => !flight.valid).length;
  return {
    total: flights.length,
    valid: flights.length - tampered,
    tampered,
    flights,
  };
}

export function renderFlightAudit(result: FlightAuditResult): string {
  if (result.total === 0) return "[FLIGHT AUDIT] полётов нет.";
  const lines = [
    `[FLIGHT AUDIT] всего ${result.total}: целых ${result.valid}, повреждённых ${result.tampered}.`,
  ];
  for (const flight of result.flights) {
    const status = flight.valid ? "ok" : "TAMPERED";
    lines.push(`  ${status} ${flight.id} ${flight.name} (${flight.events} событий)`);
    for (const error of flight.errors) lines.push(`    ${error}`);
  }
  return lines.join("\n");
}

export function renderFlightVerify(result: FlightVerifyResult): string {
  if (result.valid) return `[FLIGHT VALID] ${result.events} событий, цепочка цела.`;
  return [`[FLIGHT TAMPERED] ${result.errors.length} ошибок.`, ...result.errors.map((error) => `  ${error}`)].join("\n");
}

export function renderFlightStart(session: FlightSession): string {
  return `Полёт ${session.meta.id} начат (${session.meta.name}).`;
}

export function renderFlightCheckpoint(checkpoint: FlightCheckpoint): string {
  return `Чекпоинт ${checkpoint.label}: ${checkpoint.commit.slice(0, 12)} (tree ${checkpoint.tree.slice(0, 12)}).`;
}

export function renderFlightExec(result: FlightExecResult): string {
  const status = result.timedOut ? "таймаут" : `код ${result.exitCode ?? "?"}`;
  return `Команда ${result.command.join(" ")}: ${status}, ${result.durationMs} мс.`;
}

export function renderFlightEnd(summary: Record<string, unknown>): string {
  return `Полёт завершён: чекпоинтов ${String(summary.checkpoints ?? 0)}, команд ${String(summary.commands ?? 0)}, ${String(summary.durationMs ?? 0)} мс.`;
}

export interface FlightReplayResult {
  id: string;
  label: string;
  commit: string;
  path: string;
}

export interface FlightRestoreResult {
  id: string;
  label: string;
  commit: string;
  mode: "restore";
  dryRun: boolean;
  files: string[];
}

export interface FlightBisectStep {
  label: string;
  commit: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
}

export interface FlightBisectResult {
  id: string;
  command: string[];
  steps: FlightBisectStep[];
  firstBad?: FlightBisectStep;
}

export interface FlightDiffResult {
  id: string;
  from: { label: string; commit: string };
  to: { label: string; commit: string };
  stat: string;
  patch: string;
}

export interface FlightCompareSide {
  id: string;
  name: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  events: number;
  commands: number;
  checkpoints: number;
  failedCommands: number;
  valid: boolean;
  baseCommit: string | null;
  finalCheckpoint?: { label: string; commit: string; tree: string };
}

export interface FlightCompareResult {
  a: FlightCompareSide;
  b: FlightCompareSide;
  common: string[][];
  onlyA: string[][];
  onlyB: string[][];
  exitCodeDifferences: Array<{ command: string[]; a: number | null; b: number | null }>;
  sameFinalTree: boolean | null;
}

export interface FlightBundleSignature {
  type: "hmac-sha256";
  value: string;
}

export interface FlightExportResult {
  format: string;
  exportedAt: string;
  meta: FlightMeta;
  verification: FlightVerifyResult;
  events: FlightEvent[];
  checkpoints: Array<FlightCheckpoint & { patch: string }>;
  digest: string;
  signature?: FlightBundleSignature;
}

export interface FlightBundleVerifyResult {
  format: string;
  id?: string;
  digestOk: boolean;
  chainOk: boolean;
  signature: "valid" | "invalid" | "missing" | "unchecked";
  valid: boolean;
  errors: string[];
}

function resolveFlightId(cwd: string, id?: string): string {
  if (id && id.trim().length > 0) return id.trim();
  const active = activeFlight(cwd);
  if (active) return active.meta.id;
  const latest = listFlights(cwd)[0];
  if (latest) return latest.id;
  throw new PilotError("Полёт не запущен.", {
    hint: "Запустите oc-pilot flight start или укажите --id.",
  });
}

function flightCheckpoints(show: FlightShow): FlightCheckpoint[] {
  return show.events
    .filter((event) => event.kind === "file.checkpoint")
    .map((event) => event.payload as unknown as FlightCheckpoint);
}

function resolveCheckpoint(checkpoints: FlightCheckpoint[], ref?: string): FlightCheckpoint {
  if (checkpoints.length === 0) {
    throw new PilotError("В полёте нет чекпоинтов.", {
      hint: "Создайте чекпоинт: oc-pilot flight checkpoint --label <метка>.",
    });
  }
  if (!ref) return checkpoints[checkpoints.length - 1]!;
  const exact = [...checkpoints].reverse().find((checkpoint) => checkpoint.label === ref);
  if (exact) return exact;
  const byCommit = [...checkpoints].reverse().find((checkpoint) => checkpoint.commit.startsWith(ref));
  if (byCommit) return byCommit;
  throw new PilotError(`Чекпоинт не найден: ${ref}.`, {
    hint: "Посмотрите oc-pilot flight show <id>.",
  });
}

function sanitizeLabel(label: string): string {
  return label.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40) || "checkpoint";
}

function removeWorktree(cwd: string, path: string): void {
  const result = runGit(["worktree", "remove", "--force", path], cwd);
  if (result.status !== 0) rmSync(path, { recursive: true, force: true });
}

export function replayFlight(
  cwd: string,
  id?: string,
  to?: string,
  path?: string,
): FlightReplayResult {
  const show = showFlight(cwd, resolveFlightId(cwd, id));
  const checkpoint = resolveCheckpoint(flightCheckpoints(show), to);
  const target = path
    ? resolve(cwd, path)
    : join(
        tmpdir(),
        `oc-pilot-flight-${show.meta.id}-${sanitizeLabel(checkpoint.label)}-${randomBytes(3).toString("hex")}`,
      );
  if (existsSync(target)) {
    throw new PilotError(`Путь уже существует: ${target}.`, {
      hint: "Укажите другой --path или удалите старый worktree.",
    });
  }
  const result = runGit(["worktree", "add", "--detach", target, checkpoint.commit], cwd);
  if (result.status !== 0) {
    throw new PilotError(`Не удалось создать worktree: ${result.stderr.trim() || "git worktree failed"}.`);
  }
  return { id: show.meta.id, label: checkpoint.label, commit: checkpoint.commit, path: target };
}

export function restoreFlight(
  cwd: string,
  ref?: string,
  id?: string,
  force = false,
  dryRun = false,
): FlightRestoreResult {
  const show = showFlight(cwd, resolveFlightId(cwd, id));
  const checkpoint = resolveCheckpoint(flightCheckpoints(show), ref);
  const diff = runGit(["diff", "--name-only", checkpoint.commit, "--", "."], cwd);
  if (diff.status !== 0) {
    throw new PilotError(`Не удалось сравнить чекпоинт: ${diff.stderr.trim() || "git diff failed"}.`);
  }
  const files = diff.stdout
    .split("\n")
    .map((file) => file.trim())
    .filter((file) => file.length > 0);
  if (dryRun) {
    return {
      id: show.meta.id,
      label: checkpoint.label,
      commit: checkpoint.commit,
      mode: "restore",
      dryRun: true,
      files,
    };
  }
  const status = runGit(["status", "--porcelain"], cwd);
  if (status.status !== 0) {
    throw new PilotError(`Не удалось проверить рабочее дерево: ${status.stderr.trim() || "git status failed"}.`);
  }
  if (!force && status.stdout.trim().length > 0) {
    throw new PilotError("Рабочее дерево содержит изменения.", {
      hint: "Сделайте коммит, stash или используйте --force.",
    });
  }
  const restore = runGit(["restore", "--source", checkpoint.commit, "--worktree", "--", "."], cwd);
  if (restore.status !== 0) {
    throw new PilotError(`Не удалось восстановить чекпоинт: ${restore.stderr.trim() || "git restore failed"}.`);
  }
  return {
    id: show.meta.id,
    label: checkpoint.label,
    commit: checkpoint.commit,
    mode: "restore",
    dryRun: false,
    files,
  };
}

export function bisectFlight(
  cwd: string,
  id: string | undefined,
  command: string[],
  timeoutMs = 600_000,
): FlightBisectResult {
  if (command.length === 0) {
    throw new PilotError("Не указана команда для bisect.", {
      hint: "Передайте команду после --: oc-pilot flight bisect -- <команда>.",
    });
  }
  const show = showFlight(cwd, resolveFlightId(cwd, id));
  const checkpoints = flightCheckpoints(show);
  if (checkpoints.length === 0) {
    throw new PilotError("В полёте нет чекпоинтов для bisect.", {
      hint: "Создайте чекпоинты: oc-pilot flight checkpoint --label <метка>.",
    });
  }
  const steps: FlightBisectStep[] = [];
  let firstBad: FlightBisectStep | undefined;
  for (const checkpoint of checkpoints) {
    const replay = replayFlight(cwd, show.meta.id, checkpoint.commit);
    const startedAt = Date.now();
    const result = spawnSync(command[0]!, command.slice(1), {
      cwd: replay.path,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    const timedOut = errorCode === "ETIMEDOUT" || result.signal === "SIGTERM";
    const exitCode = typeof result.status === "number" ? result.status : null;
    const step: FlightBisectStep = {
      label: checkpoint.label,
      commit: checkpoint.commit,
      exitCode,
      timedOut,
      durationMs: Date.now() - startedAt,
      stdoutTail: tail(result.stdout ?? ""),
      stderrTail: tail(result.stderr ?? ""),
    };
    steps.push(step);
    removeWorktree(cwd, replay.path);
    if (timedOut || exitCode !== 0) {
      firstBad = step;
      break;
    }
  }
  return firstBad ? { id: show.meta.id, command, steps, firstBad } : { id: show.meta.id, command, steps };
}

export function diffFlight(
  cwd: string,
  id?: string,
  fromRef?: string,
  toRef?: string,
): FlightDiffResult {
  const show = showFlight(cwd, resolveFlightId(cwd, id));
  const checkpoints = flightCheckpoints(show);
  const base = show.meta.baseCommit ?? "HEAD";
  const from = fromRef
    ? { label: fromRef, commit: resolveCheckpoint(checkpoints, fromRef).commit }
    : { label: "base", commit: base };
  const to = toRef
    ? { label: toRef, commit: resolveCheckpoint(checkpoints, toRef).commit }
    : { label: checkpoints[checkpoints.length - 1]?.label ?? "head", commit: checkpoints[checkpoints.length - 1]?.commit ?? "HEAD" };
  const stat = runGit(["diff", "--no-color", "--stat", from.commit, to.commit], cwd);
  const patch = runGit(["diff", "--no-color", from.commit, to.commit], cwd);
  if (stat.status !== 0 || patch.status !== 0) {
    throw new PilotError(`Не удалось получить diff: ${(stat.stderr || patch.stderr).trim() || "git diff failed"}.`);
  }
  const limit = 200_000;
  return {
    id: show.meta.id,
    from,
    to,
    stat: stat.stdout.trimEnd(),
    patch: patch.stdout.length > limit ? `${patch.stdout.slice(0, limit)}\n... (обрезано)` : patch.stdout,
  };
}

interface FlightCommandRun {
  command: string[];
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

function commandKey(command: string[]): string {
  return JSON.stringify(command);
}

function commandLabel(command: string[]): string {
  const text = command.join(" ");
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function compareSide(show: FlightShow): { side: FlightCompareSide; runs: Map<string, FlightCommandRun> } {
  const events = show.events;
  const startedAt = show.meta.startedAt;
  const endedAt = events.at(-1)?.ts ?? startedAt;
  const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
  const checkpoints = flightCheckpoints(show);
  const last = checkpoints.at(-1);
  const runs = new Map<string, FlightCommandRun>();
  for (const event of events) {
    if (event.kind !== "command.end") continue;
    const payload = event.payload as Record<string, unknown>;
    const command = Array.isArray(payload.command)
      ? payload.command.filter((part): part is string => typeof part === "string")
      : [];
    if (command.length === 0) continue;
    const run: FlightCommandRun = {
      command,
      exitCode: typeof payload.exitCode === "number" ? payload.exitCode : null,
      timedOut: payload.timedOut === true,
      durationMs: typeof payload.durationMs === "number" ? payload.durationMs : 0,
    };
    runs.set(commandKey(command), run);
  }
  const failedCommands = [...runs.values()].filter(
    (run) => run.timedOut || (run.exitCode !== null && run.exitCode !== 0),
  ).length;
  const side: FlightCompareSide = {
    id: show.meta.id,
    name: show.meta.name,
    startedAt,
    endedAt,
    durationMs,
    events: events.length,
    commands: events.filter((event) => event.kind === "command.start").length,
    checkpoints: checkpoints.length,
    failedCommands,
    valid: show.verification.valid,
    baseCommit: show.meta.baseCommit,
    finalCheckpoint: last ? { label: last.label, commit: last.commit, tree: last.tree } : undefined,
  };
  return { side, runs };
}

export function compareFlights(cwd: string, idA: string, idB: string): FlightCompareResult {
  const left = compareSide(showFlight(cwd, idA));
  const right = compareSide(showFlight(cwd, idB));
  const common: string[][] = [];
  const onlyA: string[][] = [];
  const onlyB: string[][] = [];
  for (const [key, run] of left.runs) {
    if (right.runs.has(key)) common.push(run.command);
    else onlyA.push(run.command);
  }
  for (const [key, run] of right.runs) {
    if (!left.runs.has(key)) onlyB.push(run.command);
  }
  const exitCodeDifferences: FlightCompareResult["exitCodeDifferences"] = [];
  for (const [key, leftRun] of left.runs) {
    const rightRun = right.runs.get(key);
    if (!rightRun) continue;
    if (leftRun.exitCode !== rightRun.exitCode || leftRun.timedOut !== rightRun.timedOut) {
      exitCodeDifferences.push({
        command: leftRun.command,
        a: leftRun.timedOut ? null : leftRun.exitCode,
        b: rightRun.timedOut ? null : rightRun.exitCode,
      });
    }
  }
  const sameFinalTree =
    left.side.finalCheckpoint && right.side.finalCheckpoint
      ? left.side.finalCheckpoint.tree === right.side.finalCheckpoint.tree
      : null;
  return {
    a: left.side,
    b: right.side,
    common,
    onlyA,
    onlyB,
    exitCodeDifferences,
    sameFinalTree,
  };
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /((?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?)[^"'\s]{8,}/gi,
];

function redactText(text: string): string {
  let output = text;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (_match, prefix: unknown) =>
      typeof prefix === "string" && prefix.length > 0 ? `${prefix}[REDACTED]` : "[REDACTED]",
    );
  }
  return output;
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, redactValue(entry)]),
    );
  }
  return value;
}

type FlightBundleBase = Omit<FlightExportResult, "digest" | "signature">;

function flightBundleDigest(manifest: FlightBundleBase): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(manifest)).digest("hex")}`;
}

function hmacFlightDigest(key: Buffer, digest: string): string {
  return createHmac("sha256", key).update(digest).digest("hex");
}

export function generateFlightKey(): string {
  return randomBytes(32).toString("hex");
}

export function exportFlight(cwd: string, id?: string, keyPath?: string): FlightExportResult {
  const show = showFlight(cwd, resolveFlightId(cwd, id));
  const base = show.meta.baseCommit ?? "HEAD";
  const checkpoints = flightCheckpoints(show).map((checkpoint) => {
    const patch = runGit(["diff", "--no-color", base, checkpoint.commit], cwd);
    return {
      ...checkpoint,
      patch: patch.status === 0 ? redactText(patch.stdout) : "",
    };
  });
  const manifest: FlightBundleBase = {
    format: "oc-pilot-flight-export/v1",
    exportedAt: new Date().toISOString(),
    meta: { ...show.meta, cwd: "." },
    verification: show.verification,
    events: show.events.map((event) => redactValue(event) as FlightEvent),
    checkpoints,
  };
  const digest = flightBundleDigest(manifest);
  const result: FlightExportResult = { ...manifest, digest };
  if (keyPath) {
    result.signature = {
      type: "hmac-sha256",
      value: hmacFlightDigest(readFileSync(keyPath), digest),
    };
  }
  return result;
}

export function verifyFlightBundle(file: string, keyPath?: string): FlightBundleVerifyResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new PilotError(`Не удалось прочитать flight bundle: ${error instanceof Error ? error.message : String(error)}`, {
      hint: "Передайте JSON-файл, созданный oc-pilot flight export.",
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PilotError("Flight bundle должен быть JSON-объектом.", {
      hint: "Передайте файл, созданный oc-pilot flight export.",
    });
  }
  const bundle = parsed as FlightExportResult;
  if (
    typeof bundle.format !== "string" ||
    typeof bundle.digest !== "string" ||
    !bundle.meta ||
    typeof bundle.meta !== "object" ||
    !Array.isArray(bundle.events)
  ) {
    throw new PilotError("Flight bundle повреждён: нет обязательных полей.", {
      hint: "Передайте файл, созданный oc-pilot flight export.",
    });
  }
  const { digest, signature, ...base } = bundle;
  const digestOk = flightBundleDigest(base) === digest;
  const chain = verifyFlightEvents(bundle.events);
  const errors: string[] = [];
  if (!digestOk) errors.push("digest не совпадает");
  if (!chain.valid) errors.push(...chain.errors);
  let signatureStatus: FlightBundleVerifyResult["signature"] = "missing";
  if (signature !== undefined) {
    if (
      typeof signature !== "object" ||
      signature === null ||
      signature.type !== "hmac-sha256" ||
      typeof signature.value !== "string"
    ) {
      signatureStatus = "invalid";
      errors.push("неизвестный формат подписи");
    } else if (!keyPath) {
      signatureStatus = "unchecked";
      errors.push("подпись есть, но ключ не указан");
    } else {
      const expected = Buffer.from(hmacFlightDigest(readFileSync(keyPath), digest), "hex");
      const actual = Buffer.from(signature.value, "hex");
      signatureStatus =
        expected.length === actual.length && timingSafeEqual(expected, actual) ? "valid" : "invalid";
      if (signatureStatus === "invalid") errors.push("подпись не совпадает");
    }
  }
  return {
    format: bundle.format,
    id: typeof bundle.meta.id === "string" ? bundle.meta.id : undefined,
    digestOk,
    chainOk: chain.valid,
    signature: signatureStatus,
    valid: digestOk && chain.valid && signatureStatus !== "invalid" && signatureStatus !== "unchecked",
    errors,
  };
}

export function renderFlightReplay(result: FlightReplayResult): string {
  return `[FLIGHT REPLAY] ${result.label} (${result.commit.slice(0, 12)}) → ${result.path}`;
}

export function renderFlightRestore(result: FlightRestoreResult): string {
  const files = result.files.length > 0 ? `: ${result.files.join(", ")}` : "";
  return `[FLIGHT RESTORE] ${result.dryRun ? "будет восстановлено" : "восстановлено"} ${result.label} (${result.commit.slice(0, 12)})${files}`;
}

export function renderFlightBisect(result: FlightBisectResult): string {
  const lines = [`[FLIGHT BISECT] ${result.id}: ${result.steps.length} чекпоинтов.`];
  for (const step of result.steps) {
    const marker = step === result.firstBad ? "FAIL" : "ok";
    lines.push(
      `  ${marker} ${step.label} ${step.commit.slice(0, 12)} exit ${step.exitCode ?? "?"}${step.timedOut ? " timeout" : ""}`,
    );
  }
  if (result.firstBad) {
    lines.push(`[FIRST BAD STEP] ${result.firstBad.label} (${result.firstBad.commit.slice(0, 12)}).`);
  } else {
    lines.push("[FLIGHT BISECT] все чекпоинты прошли.");
  }
  return lines.join("\n");
}

export function renderFlightDiff(result: FlightDiffResult): string {
  return [`[FLIGHT DIFF] ${result.from.label}..${result.to.label}`, result.stat, result.patch]
    .filter((part) => part.length > 0)
    .join("\n");
}

export function renderFlightCompareHtml(result: FlightCompareResult): string {
  const side = (label: string, value: FlightCompareSide): string => `<section class="card">
<h2>${label}: ${escapeHtml(value.name)}</h2>
<p class="id">${escapeHtml(value.id)}</p>
<span class="badge ${value.valid ? "ok" : "bad"}">${value.valid ? "chain valid" : "chain tampered"}</span>
<dl>
<div><dt>Events</dt><dd>${value.events}</dd></div>
<div><dt>Commands</dt><dd>${value.commands}</dd></div>
<div><dt>Checkpoints</dt><dd>${value.checkpoints}</dd></div>
<div><dt>Failed commands</dt><dd>${value.failedCommands}</dd></div>
<div><dt>Duration</dt><dd>${value.durationMs} ms</dd></div>
</dl>
</section>`;
  const commandList = (commands: string[][]): string =>
    commands.length === 0
      ? `<p class="muted">none</p>`
      : `<ul>${commands.map((command) => `<li><code>${escapeHtml(commandLabel(command))}</code></li>`).join("")}</ul>`;
  const differences =
    result.exitCodeDifferences.length === 0
      ? `<p class="muted">none</p>`
      : `<table><thead><tr><th>Command</th><th>A</th><th>B</th></tr></thead><tbody>${result.exitCodeDifferences
          .map(
            (difference) =>
              `<tr><td><code>${escapeHtml(commandLabel(difference.command))}</code></td><td>${difference.a ?? "?"}</td><td>${difference.b ?? "?"}</td></tr>`,
          )
          .join("")}</tbody></table>`;
  const tree =
    result.sameFinalTree === null
      ? "no checkpoint on one side"
      : result.sameFinalTree
        ? "same tree"
        : "different tree";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>oc-pilot flight compare</title>
<style>
:root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --ink:#17191d; --muted:#68707d; --line:#d9dde4; --accent:#2457d6; --ok:#177245; --bad:#b42318; }
@media (prefers-color-scheme: dark) { :root { --bg:#111318; --card:#181b22; --ink:#e8ebf0; --muted:#9aa3b1; --line:#2b303a; --accent:#8ab4ff; --ok:#63d391; --bad:#ff8a80; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width:1080px; margin:0 auto; padding:40px 20px 64px; }
h1 { margin:0 0 20px; font-size:clamp(28px,5vw,44px); line-height:1.1; }
.cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:16px; }
.card, section { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:18px; margin:16px 0; }
.card h2 { margin:0 0 2px; font-size:18px; }
.id { margin:0 0 10px; color:var(--muted); font-family:ui-monospace, SFMono-Regular, Consolas, monospace; }
.badge { display:inline-block; padding:3px 10px; border:1px solid currentColor; border-radius:999px; font-size:12px; font-weight:700; }
.badge.ok { color:var(--ok); } .badge.bad { color:var(--bad); }
dl { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:8px; margin:16px 0 0; }
dt { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.06em; }
dd { margin:2px 0 0; font-weight:700; }
h2 { margin:0 0 12px; font-size:18px; }
ul { margin:0; padding-left:20px; }
code, pre { font-family:ui-monospace, SFMono-Regular, Consolas, monospace; }
table { width:100%; border-collapse:collapse; }
th, td { padding:8px; border-top:1px solid var(--line); text-align:left; }
th { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.06em; }
.muted { color:var(--muted); }
</style>
</head>
<body>
<main>
<h1>oc-pilot flight compare</h1>
<div class="cards">${side("A", result.a)}${side("B", result.b)}</div>
<section><h2>Only in A</h2>${commandList(result.onlyA)}</section>
<section><h2>Only in B</h2>${commandList(result.onlyB)}</section>
<section><h2>Exit code differences</h2>${differences}</section>
<section><h2>Final tree</h2><p>${escapeHtml(tree)}</p></section>
</main>
</body>
</html>`;
}

export function renderFlightExport(result: FlightExportResult): string {
  return `[FLIGHT EXPORT] ${result.meta.id}: ${result.events.length} событий, ${result.checkpoints.length} чекпоинтов, ${result.digest.slice(0, 19)}.`;
}

export function renderFlightBundleVerify(result: FlightBundleVerifyResult): string {
  const lines = [
    `[FLIGHT BUNDLE] ${result.format}`,
    `ID: ${result.id ?? "?"}`,
    `Digest: ${result.digestOk ? "ok" : "mismatch"}`,
    `Chain: ${result.chainOk ? "ok" : "broken"}`,
    `Signature: ${result.signature}`,
  ];
  if (result.errors.length > 0) {
    lines.push("", ...result.errors.map((error) => `! ${error}`));
  }
  return lines.join("\n");
}

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    if (character === '"') return "&quot;";
    return "&#39;";
  });
}

function htmlEventDetail(event: FlightEvent): string {
  const payload = event.payload;
  if (event.kind === "command.end") {
    const parts = [`exit ${String(payload.exitCode ?? "?")}`];
    if (payload.timedOut === true) parts.push("timeout");
    if (typeof payload.durationMs === "number") parts.push(`${payload.durationMs} ms`);
    return parts.join(" · ");
  }
  if (event.kind === "file.checkpoint") {
    return `commit ${String(payload.commit ?? "").slice(0, 12)}`;
  }
  if (event.kind === "session.end") {
    return `${String(payload.checkpoints ?? 0)} checkpoints · ${String(payload.commands ?? 0)} commands`;
  }
  return "";
}

function htmlEventOutput(event: FlightEvent): string {
  const payload = event.payload;
  const blocks: string[] = [];
  for (const [label, key] of [
    ["stdout", "stdoutTail"],
    ["stderr", "stderrTail"],
  ] as const) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      blocks.push(`<details><summary>${label}</summary><pre>${escapeHtml(value)}</pre></details>`);
    }
  }
  return blocks.join("");
}

export function renderFlightHtml(result: FlightExportResult): string {
  const meta = result.meta;
  const checkpointRows =
    result.checkpoints.length === 0
      ? `<tr><td colspan="4" class="muted">No checkpoints.</td></tr>`
      : result.checkpoints
          .map(
            (checkpoint) => `<tr>
<td>${escapeHtml(checkpoint.label)}</td>
<td><code>${escapeHtml(checkpoint.commit.slice(0, 12))}</code></td>
<td>${escapeHtml(checkpoint.createdAt)}</td>
<td>${
              checkpoint.patch.trim().length > 0
                ? `<details><summary>patch</summary><pre>${escapeHtml(checkpoint.patch)}</pre></details>`
                : `<span class="muted">—</span>`
            }</td>
</tr>`,
          )
          .join("\n");
  const timeline = result.events
    .map((event) => {
      const detail = htmlEventDetail(event);
      const output = htmlEventOutput(event);
      return `<li>
<div class="event-head"><span class="seq">#${event.seq}</span><span class="kind">${escapeHtml(event.kind)}</span><time>${escapeHtml(event.ts)}</time></div>
<div class="event-title">${escapeHtml(eventSummary(event))}</div>
${detail ? `<div class="event-detail">${escapeHtml(detail)}</div>` : ""}
${output}
</li>`;
    })
    .join("\n");
  const errors = result.verification.valid
    ? ""
    : `<section class="errors"><h2>Chain errors</h2><ul>${result.verification.errors
        .map((error) => `<li>${escapeHtml(error)}</li>`)
        .join("")}</ul></section>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>oc-pilot flight ${escapeHtml(meta.id)}</title>
<style>
:root { color-scheme: light dark; --bg: #f6f7f9; --card: #ffffff; --ink: #17191d; --muted: #68707d; --line: #d9dde4; --accent: #2457d6; --ok: #177245; --bad: #b42318; }
@media (prefers-color-scheme: dark) { :root { --bg: #111318; --card: #181b22; --ink: #e8ebf0; --muted: #9aa3b1; --line: #2b303a; --accent: #8ab4ff; --ok: #63d391; --bad: #ff8a80; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1080px; margin: 0 auto; padding: 40px 20px 64px; }
header { border-bottom: 1px solid var(--line); padding-bottom: 20px; margin-bottom: 24px; }
.eyebrow { color: var(--accent); font-size: 12px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
h1 { margin: 6px 0 4px; font-size: clamp(28px, 5vw, 44px); line-height: 1.1; }
.id { margin: 0; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.badge { display: inline-block; margin-top: 12px; padding: 3px 10px; border: 1px solid currentColor; border-radius: 999px; font-size: 12px; font-weight: 700; }
.badge.ok { color: var(--ok); } .badge.bad { color: var(--bad); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 24px 0; }
.grid > div, section { background: var(--card); border: 1px solid var(--line); border-radius: 10px; }
.grid > div { padding: 12px 14px; }
.grid span { display: block; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
.grid strong { display: block; margin-top: 4px; overflow-wrap: anywhere; }
section { padding: 18px; margin: 18px 0; }
h2 { margin: 0 0 12px; font-size: 18px; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 9px 8px; border-top: 1px solid var(--line); text-align: left; vertical-align: top; }
th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
code, pre { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
pre { margin: 8px 0 0; padding: 12px; overflow: auto; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
details summary { cursor: pointer; color: var(--accent); }
.timeline { list-style: none; margin: 0; padding: 0; }
.timeline li { padding: 12px 0; border-top: 1px solid var(--line); }
.timeline li:first-child { border-top: 0; }
.event-head { display: flex; gap: 10px; align-items: baseline; color: var(--muted); font-size: 12px; }
.seq { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.kind { color: var(--accent); font-weight: 700; }
.event-head time { margin-left: auto; }
.event-title { margin-top: 3px; font-weight: 600; overflow-wrap: anywhere; }
.event-detail { color: var(--muted); font-size: 13px; }
.muted { color: var(--muted); }
.errors { border-color: var(--bad); }
.errors h2 { color: var(--bad); }
footer { color: var(--muted); font-size: 12px; margin-top: 24px; overflow-wrap: anywhere; }
</style>
</head>
<body>
<main>
<header>
<div class="eyebrow">oc-pilot flight</div>
<h1>${escapeHtml(meta.name)}</h1>
<p class="id">${escapeHtml(meta.id)}</p>
<span class="badge ${result.verification.valid ? "ok" : "bad"}">${result.verification.valid ? "chain valid" : "chain tampered"}</span>
</header>
<div class="grid">
<div><span>Started</span><strong>${escapeHtml(meta.startedAt)}</strong></div>
<div><span>Base commit</span><strong>${escapeHtml(meta.baseCommit ?? "none")}</strong></div>
<div><span>Branch</span><strong>${escapeHtml(meta.branch ?? "none")}</strong></div>
<div><span>Events</span><strong>${result.events.length}</strong></div>
<div><span>Checkpoints</span><strong>${result.checkpoints.length}</strong></div>
<div><span>Digest</span><strong><code>${escapeHtml(result.digest)}</code></strong></div>
</div>
${errors}
<section>
<h2>Checkpoints</h2>
<table>
<thead><tr><th>Label</th><th>Commit</th><th>Created</th><th>Patch</th></tr></thead>
<tbody>${checkpointRows}</tbody>
</table>
</section>
<section>
<h2>Timeline</h2>
<ol class="timeline">${timeline}</ol>
</section>
<footer>Exported ${escapeHtml(result.exportedAt)} · ${escapeHtml(result.format)}</footer>
</main>
</body>
</html>`;
}

export function renderFlightCompare(result: FlightCompareResult): string {
  const side = (label: string, value: FlightCompareSide): string =>
    `${label}: ${value.name} (${value.id}) — событий ${value.events}, команд ${value.commands}, ` +
    `чекпоинтов ${value.checkpoints}, ошибок ${value.failedCommands}, ${value.durationMs} мс, ` +
    `цепочка ${value.valid ? "валидна" : "повреждена"}`;
  const lines = [
    `[FLIGHT COMPARE] ${result.a.id} ↔ ${result.b.id}`,
    side("A", result.a),
    side("B", result.b),
  ];
  if (result.onlyA.length > 0) {
    lines.push(`Только в A: ${result.onlyA.map(commandLabel).join("; ")}`);
  }
  if (result.onlyB.length > 0) {
    lines.push(`Только в B: ${result.onlyB.map(commandLabel).join("; ")}`);
  }
  if (result.common.length > 0) {
    lines.push(`Общие команды: ${result.common.length}.`);
  }
  if (result.exitCodeDifferences.length > 0) {
    lines.push("Расхождения exit code:");
    for (const difference of result.exitCodeDifferences) {
      lines.push(
        `  ${commandLabel(difference.command)}: A ${difference.a ?? "?"}, B ${difference.b ?? "?"}`,
      );
    }
  }
  lines.push(
    `Итоговое дерево: ${
      result.sameFinalTree === null
        ? "нет чекпоинтов у одного из полётов"
        : result.sameFinalTree
          ? "совпадает"
          : "различается"
    }.`,
  );
  return lines.join("\n");
}
