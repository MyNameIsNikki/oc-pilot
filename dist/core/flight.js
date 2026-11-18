import { spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { PilotError } from "./errors.js";
import { getRepoRoot, runGit } from "./git.js";
const MAX_TAIL = 8000;
function isAbsoluteLike(value) {
    return /^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(value);
}
function canonicalJson(value) {
    if (value === undefined)
        return "null";
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(",")}]`;
    const record = value;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
export function flightEventHash(event) {
    return `sha256:${createHash("sha256").update(canonicalJson(event)).digest("hex")}`;
}
export function flightsRoot(cwd) {
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
export function newFlightId(now = new Date()) {
    const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    return `${stamp}-${randomBytes(3).toString("hex")}`;
}
function sessionDir(root, id) {
    if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") {
        throw new PilotError(`Некорректный идентификатор полёта: ${id}`, {
            hint: "Используйте идентификатор из oc-pilot flight list.",
            exitCode: 2,
        });
    }
    return join(root, id);
}
function metaPath(dir) {
    return join(dir, "meta.json");
}
function eventsPath(dir) {
    return join(dir, "events.jsonl");
}
function currentPath(root) {
    return join(root, "current");
}
function readMeta(dir) {
    const text = readFileSync(metaPath(dir), "utf8");
    return JSON.parse(text);
}
function writeMeta(dir, meta) {
    writeFileSync(metaPath(dir), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}
export function readFlightEvents(dir) {
    const file = eventsPath(dir);
    if (!existsSync(file))
        return [];
    const text = readFileSync(file, "utf8");
    const events = [];
    for (const [index, line] of text.split(/\r?\n/).entries()) {
        if (!line.trim())
            continue;
        let event;
        try {
            event = JSON.parse(line);
        }
        catch {
            throw new PilotError(`Повреждён журнал полёта: строка ${index + 1}.`, {
                hint: "Журнал нельзя прочитать; проверьте events.jsonl вручную.",
            });
        }
        events.push(event);
    }
    return events;
}
export function appendFlightEvent(dir, kind, payload) {
    const events = readFlightEvents(dir);
    const last = events.at(-1);
    const base = {
        seq: (last?.seq ?? 0) + 1,
        ts: new Date().toISOString(),
        kind,
        prev: last?.hash ?? "genesis",
        payload,
    };
    const event = { ...base, hash: flightEventHash(base) };
    appendFileSync(eventsPath(dir), `${JSON.stringify(event)}\n`, "utf8");
    return event;
}
export function addFlightNote(cwd, text) {
    const note = text.trim();
    if (note.length === 0) {
        throw new PilotError("Пустая заметка.", {
            hint: "Передайте текст: oc-pilot flight note \"...\".",
            exitCode: 2,
        });
    }
    const session = requireActiveFlight(cwd);
    const event = appendFlightEvent(session.dir, "note", { text: note });
    return { id: session.meta.id, seq: event.seq, note };
}
export function verifyFlightEvents(events) {
    const errors = [];
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
    if (events.length === 0)
        errors.push("Журнал пуст.");
    return { valid: errors.length === 0, events: events.length, errors };
}
export function startFlight(cwd, name) {
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
    const meta = {
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
export function activeFlight(cwd) {
    const root = flightsRoot(cwd);
    const current = currentPath(root);
    if (!existsSync(current))
        return undefined;
    const id = readFileSync(current, "utf8").trim();
    if (!id)
        return undefined;
    const dir = sessionDir(root, id);
    if (!existsSync(metaPath(dir)))
        return undefined;
    const meta = readMeta(dir);
    return { dir, meta, events: readFlightEvents(dir) };
}
export function requireActiveFlight(cwd) {
    const session = activeFlight(cwd);
    if (!session) {
        throw new PilotError("Полёт не запущен.", {
            hint: "Начните: oc-pilot flight start --name \"...\".",
            exitCode: 2,
        });
    }
    return session;
}
function runGitWithEnv(args, cwd, env) {
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
export function createCheckpoint(cwd, label) {
    const session = requireActiveFlight(cwd);
    const repoRoot = getRepoRoot(cwd);
    const indexFile = join(session.dir, `index-${randomBytes(4).toString("hex")}.tmp`);
    const env = {
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
        if (head.status === 0)
            args.push("-p", head.stdout.trim());
        args.push("-m", `oc-pilot flight checkpoint: ${label}`);
        const commitResult = runGitWithEnv(args, repoRoot, env);
        if (commitResult.status !== 0) {
            throw new PilotError("Не удалось создать снимок полёта.", {
                hint: commitResult.stderr.trim() || "Проверьте git-репозиторий.",
            });
        }
        const checkpoint = {
            label,
            tree,
            commit: commitResult.stdout.trim(),
            createdAt: new Date().toISOString(),
        };
        appendFlightEvent(session.dir, "file.checkpoint", { ...checkpoint });
        return checkpoint;
    }
    finally {
        rmSync(indexFile, { force: true });
    }
}
function tail(value) {
    if (value.length <= MAX_TAIL)
        return value;
    return value.slice(-MAX_TAIL);
}
export function execInFlight(cwd, command, options = {}) {
    const session = requireActiveFlight(cwd);
    if (command.length === 0) {
        throw new PilotError("Не указана команда для flight exec.", {
            hint: "Используйте: oc-pilot flight exec -- npm test.",
        });
    }
    const timeoutMs = options.timeoutMs ?? 600_000;
    const started = Date.now();
    const eventStart = appendFlightEvent(session.dir, "command.start", { command, timeoutMs });
    const result = spawnSync(command[0], command.slice(1), {
        cwd,
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
    });
    const durationMs = Date.now() - started;
    const timedOut = result.signal === "SIGTERM" ||
        result.error?.code === "ETIMEDOUT";
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
        if (result.stdout)
            process.stdout.write(result.stdout);
        if (result.stderr)
            process.stderr.write(result.stderr);
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
export function endFlight(cwd) {
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
export function listFlights(cwd) {
    const root = flightsRoot(cwd);
    if (!existsSync(root))
        return [];
    const entries = [];
    for (const name of readdirSync(root)) {
        const dir = sessionDir(root, name);
        if (!existsSync(metaPath(dir)))
            continue;
        const meta = readMeta(dir);
        const events = readFlightEvents(dir);
        entries.push({
            ...meta,
            events: events.length,
            checkpoints: events.filter((event) => event.kind === "file.checkpoint").length,
            notes: events.filter((event) => event.kind === "note").length,
            ended: events.some((event) => event.kind === "session.end"),
        });
    }
    return entries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
export function flightStats(cwd) {
    const flights = listFlights(cwd);
    const commands = new Map();
    let events = 0;
    let commandCount = 0;
    let notes = 0;
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
            if (event.kind === "command.start")
                commandCount += 1;
            if (event.kind === "note")
                notes += 1;
            if (event.kind !== "command.end")
                continue;
            const payload = event.payload;
            const command = Array.isArray(payload.command)
                ? payload.command.filter((part) => typeof part === "string")
                : [];
            if (command.length === 0)
                continue;
            const key = JSON.stringify(command);
            const current = commands.get(key) ?? { command: command.join(" "), runs: 0, failures: 0 };
            current.runs += 1;
            if (payload.timedOut === true ||
                (typeof payload.exitCode === "number" && payload.exitCode !== 0)) {
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
        notes,
        checkpoints,
        failedCommands,
        durationMs,
        averageDurationMs: flights.length === 0 ? 0 : Math.round(durationMs / flights.length),
        topCommands,
    };
}
export function pruneFlights(cwd, options = {}) {
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
    const remove = new Set();
    ended.forEach((flight, index) => {
        if (index < keep)
            return;
        if (cutoff !== undefined && Date.parse(flight.startedAt) >= cutoff)
            return;
        remove.add(flight.id);
    });
    const removed = [];
    const root = flightsRoot(cwd);
    for (const id of remove) {
        removed.push(id);
        if (options.dryRun !== true)
            rmSync(sessionDir(root, id), { recursive: true, force: true });
    }
    return {
        removed,
        kept: flights.length - removed.length,
        active,
        dryRun: options.dryRun === true,
    };
}
export function deleteFlight(cwd, id, dryRun = false) {
    const target = id.trim();
    if (!target) {
        throw new PilotError("Не указан идентификатор полёта.", {
            hint: "Используйте: oc-pilot flight delete <id>.",
            exitCode: 2,
        });
    }
    const show = showFlight(cwd, target);
    const active = activeFlight(cwd);
    if (active && active.meta.id === show.meta.id) {
        throw new PilotError("Нельзя удалить активный полёт.", {
            hint: "Сначала завершите его: oc-pilot flight end.",
        });
    }
    const entry = listFlights(cwd).find((flight) => flight.id === show.meta.id);
    const result = {
        id: show.meta.id,
        name: show.meta.name,
        events: show.events.length,
        checkpoints: entry?.checkpoints ?? 0,
        removed: false,
        dryRun,
    };
    if (dryRun)
        return result;
    rmSync(sessionDir(flightsRoot(cwd), show.meta.id), { recursive: true, force: true });
    return { ...result, removed: true };
}
export function showFlight(cwd, id) {
    const root = flightsRoot(cwd);
    const resolved = resolveFlightId(cwd, id);
    const dir = sessionDir(root, resolved);
    if (!existsSync(metaPath(dir))) {
        throw new PilotError(`Полёт ${resolved} не найден.`, {
            hint: "Посмотрите список: oc-pilot flight list.",
            exitCode: 2,
        });
    }
    const meta = readMeta(dir);
    const events = readFlightEvents(dir);
    return { meta, events, verification: verifyFlightEvents(events) };
}
export function flightStatus(cwd) {
    const session = activeFlight(cwd);
    if (!session) {
        const last = listFlights(cwd)[0];
        return last ? { active: false, last } : { active: false };
    }
    const checkpoints = session.events.filter((event) => event.kind === "file.checkpoint").length;
    const commands = session.events.filter((event) => event.kind === "command.start").length;
    const notes = session.events.filter((event) => event.kind === "note").length;
    return {
        active: true,
        session,
        checkpoints,
        commands,
        notes,
        lastEvent: session.events.at(-1),
    };
}
export function renderFlightStatus(status) {
    if (!status.active || !status.session) {
        if (status.last) {
            return [
                "Полёт не запущен. Начните: oc-pilot flight start --name \"...\".",
                `Последний: ${status.last.id} (${status.last.name}), завершён: событий ${status.last.events}, чекпоинтов ${status.last.checkpoints}, заметок ${status.last.notes}`,
            ].join("\n");
        }
        return "Полёт не запущен. Начните: oc-pilot flight start --name \"...\".";
    }
    const { meta } = status.session;
    return [
        `Полёт ${meta.id} (${meta.name})`,
        `Начат: ${meta.startedAt}`,
        `Коммит: ${meta.baseCommit ?? "нет HEAD"}`,
        `Событий: ${status.session.events.length}; чекпоинтов: ${status.checkpoints ?? 0}; команд: ${status.commands ?? 0}; заметок: ${status.notes ?? 0}`,
        `Последнее событие: ${status.lastEvent?.kind ?? "нет"}`,
    ].join("\n");
}
export function renderFlightList(flights) {
    if (flights.length === 0)
        return "Полётов пока нет.";
    return flights
        .map((flight) => `${flight.id}  ${flight.ended ? "завершён" : "активен"}  ${flight.name}  событий ${flight.events}, чекпоинтов ${flight.checkpoints}, заметок ${flight.notes}`)
        .join("\n");
}
function grepEventText(event) {
    if (event.kind === "note")
        return String(event.payload.text ?? "");
    if (event.kind === "file.checkpoint")
        return String(event.payload.label ?? "");
    if (event.kind === "session.start")
        return String(event.payload.name ?? "");
    if (event.kind === "command.start" || event.kind === "command.end") {
        const parts = [];
        if (Array.isArray(event.payload.command)) {
            parts.push(event.payload.command
                .filter((part) => typeof part === "string")
                .join(" "));
        }
        if (event.kind === "command.end") {
            if (typeof event.payload.stdoutTail === "string")
                parts.push(event.payload.stdoutTail);
            if (typeof event.payload.stderrTail === "string")
                parts.push(event.payload.stderrTail);
        }
        return parts.join("\n");
    }
    return "";
}
function grepShows(shows, query, limit, kind) {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) {
        throw new PilotError("Пустой поисковый запрос.", {
            hint: "Передайте текст: oc-pilot flight grep \"...\".",
            exitCode: 2,
        });
    }
    if (!Number.isInteger(limit) || limit < 1) {
        throw new PilotError(`Некорректный --limit: ${String(limit)}`, {
            hint: "Укажите положительное целое число.",
            exitCode: 2,
        });
    }
    const kindFilter = kind?.trim();
    if (kindFilter && !FLIGHT_EVENT_KINDS.includes(kindFilter)) {
        throw new PilotError(`Неизвестный тип события: ${kindFilter}`, {
            hint: `Доступно: ${FLIGHT_EVENT_KINDS.join(", ")}.`,
            exitCode: 2,
        });
    }
    const matches = [];
    let total = 0;
    for (const show of shows) {
        for (const event of show.events) {
            if (kindFilter && event.kind !== kindFilter)
                continue;
            const text = grepEventText(event);
            if (!text.toLowerCase().includes(needle))
                continue;
            total += 1;
            if (matches.length >= limit)
                continue;
            matches.push({
                id: show.meta.id,
                name: show.meta.name,
                seq: event.seq,
                kind: event.kind,
                ts: event.ts,
                text,
            });
        }
    }
    return { query, matches, total };
}
export function grepFlights(cwd, query, id, limit = 50, kind) {
    const shows = id
        ? [showFlight(cwd, id)]
        : listFlights(cwd).map((flight) => showFlight(cwd, flight.id));
    return grepShows(shows, query, limit, kind);
}
export function grepFlightBundle(file, query, limit = 50, kind) {
    return grepShows([flightShowFromBundle(loadFlightBundle(file))], query, limit, kind);
}
export function renderFlightGrep(result) {
    if (result.total === 0) {
        return `[FLIGHT GREP] по запросу «${result.query}» ничего не найдено.`;
    }
    const lines = [`[FLIGHT GREP] ${result.total} совпадений по запросу «${result.query}».`];
    for (const match of result.matches) {
        const flat = match.text.replace(/\s+/g, " ").trim();
        const short = flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
        lines.push(`  ${match.id} #${match.seq} ${match.kind}: ${short}`);
    }
    if (result.total > result.matches.length) {
        lines.push(`  показано ${result.matches.length}; увеличьте --limit, чтобы увидеть больше.`);
    }
    return lines.join("\n");
}
export function renderFlightStats(stats) {
    if (stats.total === 0)
        return "[FLIGHT STATS] полётов нет.";
    const lines = [
        `[FLIGHT STATS] всего ${stats.total}: завершено ${stats.ended}, активно ${stats.active}.`,
        `События: ${stats.events}, команды: ${stats.commands}, заметки: ${stats.notes}, чекпоинты: ${stats.checkpoints}, ошибки команд: ${stats.failedCommands}.`,
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
export function renderFlightStatsHtml(stats) {
    const cards = [
        ["Flights", stats.total],
        ["Ended", stats.ended],
        ["Active", stats.active],
        ["Events", stats.events],
        ["Commands", stats.commands],
        ["Notes", stats.notes],
        ["Checkpoints", stats.checkpoints],
        ["Failed commands", stats.failedCommands],
        ["Duration", `${stats.durationMs} ms`],
        ["Average duration", `${stats.averageDurationMs} ms`],
    ]
        .map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`)
        .join("");
    const commands = stats.topCommands.length === 0
        ? `<p class="muted">No commands recorded yet.</p>`
        : `<table><thead><tr><th>Command</th><th>Runs</th><th>Failures</th></tr></thead><tbody>${stats.topCommands
            .map((command) => `<tr><td><code>${escapeHtml(command.command)}</code></td><td>${command.runs}</td><td>${command.failures}</td></tr>`)
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
export function renderFlightPrune(result) {
    const shown = result.removed.slice(0, 5).join(", ");
    const suffix = result.removed.length > 5 ? ` и ещё ${result.removed.length - 5}` : "";
    const list = result.removed.length > 0 ? `: ${shown}${suffix}` : "";
    return `[FLIGHT PRUNE] ${result.dryRun ? "будет удалено" : "удалено"} ${result.removed.length}${list}; осталось ${result.kept}${result.active ? `, активный ${result.active}` : ""}.`;
}
export function renderFlightDelete(result) {
    const verb = result.dryRun ? "будет удалён" : "удалён";
    return `[FLIGHT DELETE] ${verb} ${result.id} (${result.name}): событий ${result.events}, чекпоинтов ${result.checkpoints}.`;
}
export const FLIGHT_EVENT_KINDS = [
    "session.start",
    "command.start",
    "command.end",
    "file.checkpoint",
    "gate.result",
    "approval",
    "note",
    "session.end",
];
export function filterFlightEvents(events, kind, last) {
    let filtered = events;
    if (kind !== undefined) {
        const trimmed = kind.trim();
        if (!FLIGHT_EVENT_KINDS.includes(trimmed)) {
            throw new PilotError(`Неизвестный тип события: ${trimmed}`, {
                hint: `Доступно: ${FLIGHT_EVENT_KINDS.join(", ")}.`,
                exitCode: 2,
            });
        }
        filtered = filtered.filter((event) => event.kind === trimmed);
    }
    if (last !== undefined) {
        if (!Number.isInteger(last) || last < 1) {
            throw new PilotError(`Некорректный --last: ${String(last)}`, {
                hint: "Укажите положительное целое число.",
                exitCode: 2,
            });
        }
        filtered = filtered.slice(-last);
    }
    return filtered;
}
function eventSummary(event) {
    if (event.kind === "file.checkpoint") {
        return `чекпоинт ${String(event.payload.label ?? "")} (${String(event.payload.commit ?? "").slice(0, 8)})`;
    }
    if (event.kind === "note") {
        return `Заметка: ${String(event.payload.text ?? "")}`;
    }
    if (event.kind === "command.start" || event.kind === "command.end") {
        const command = Array.isArray(event.payload.command) ? event.payload.command.join(" ") : "";
        return `${command}${event.kind === "command.end" ? ` → ${String(event.payload.exitCode ?? "?")}` : ""}`;
    }
    return String(event.payload.name ?? event.kind);
}
export function renderFlightSummary(show) {
    const checkpoints = flightCheckpoints(show);
    const commands = [];
    for (const event of show.events) {
        if (event.kind !== "command.end")
            continue;
        const payload = event.payload;
        const parts = Array.isArray(payload.command)
            ? payload.command.filter((part) => typeof part === "string")
            : [];
        if (parts.length === 0)
            continue;
        commands.push({
            command: parts.join(" "),
            exitCode: typeof payload.exitCode === "number" ? payload.exitCode : undefined,
            durationMs: typeof payload.durationMs === "number" ? payload.durationMs : undefined,
        });
    }
    const startedAt = Date.parse(show.meta.startedAt);
    const lastTs = show.events.at(-1)?.ts;
    const durationMs = lastTs ? Math.max(0, Date.parse(lastTs) - startedAt) : 0;
    const failed = commands.filter((command) => command.exitCode !== undefined && command.exitCode !== 0);
    const lines = [
        `# Полёт: ${show.meta.name}`,
        "",
        `- ID: \`${show.meta.id}\``,
        `- Начат: ${show.meta.startedAt}`,
        `- База: \`${show.meta.baseCommit ?? "HEAD"}\``,
        `- Длительность: ${durationMs} мс`,
        `- События: ${show.events.length}`,
        `- Чекпоинты: ${checkpoints.length}`,
        `- Команды: ${commands.length} (ошибок: ${failed.length})`,
        `- Цепочка: ${show.verification.valid ? "целая" : "повреждена"}`,
        "",
        "## Чекпоинты",
        "",
    ];
    if (checkpoints.length === 0) {
        lines.push("_нет_");
    }
    else {
        lines.push("| Метка | Коммит |", "| --- | --- |");
        for (const checkpoint of checkpoints) {
            lines.push(`| ${checkpoint.label} | \`${checkpoint.commit.slice(0, 12)}\` |`);
        }
    }
    lines.push("", "## Команды", "");
    if (commands.length === 0) {
        lines.push("_нет_");
    }
    else {
        lines.push("| Команда | Код | Длительность |", "| --- | --- | --- |");
        for (const command of commands) {
            const code = command.exitCode === undefined ? "?" : String(command.exitCode);
            lines.push(`| \`${command.command.replaceAll("|", "\\|")}\` | ${code} | ${command.durationMs ?? 0} мс |`);
        }
    }
    const notes = show.events
        .filter((event) => event.kind === "note")
        .map((event) => String(event.payload.text ?? ""))
        .filter((note) => note.length > 0);
    if (notes.length > 0) {
        lines.push("", "## Заметки", "", ...notes.map((note) => `- ${note}`));
    }
    if (!show.verification.valid) {
        lines.push("", "## Повреждения", "", ...show.verification.errors.map((error) => `- ${error}`));
    }
    return lines.join("\n");
}
export function renderFlightShow(show) {
    const lines = [
        `Полёт ${show.meta.id} (${show.meta.name})`,
        `Начат: ${show.meta.startedAt}`,
        `Коммит: ${show.meta.baseCommit ?? "нет HEAD"}`,
        `Проверка: ${show.verification.valid ? "цепочка цела" : "цепочка повреждена"}`,
        `Событий: ${show.events.length}`,
        "",
        ...show.events.map((event) => `${String(event.seq).padStart(3, " ")}  ${event.kind}  ${eventSummary(event)}`),
    ];
    if (!show.verification.valid)
        lines.push("", ...show.verification.errors.map((error) => `! ${error}`));
    return lines.join("\n");
}
export function auditFlights(cwd) {
    const flights = [];
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
export function renderFlightAudit(result) {
    if (result.total === 0)
        return "[FLIGHT AUDIT] полётов нет.";
    const lines = [
        `[FLIGHT AUDIT] всего ${result.total}: целых ${result.valid}, повреждённых ${result.tampered}.`,
    ];
    for (const flight of result.flights) {
        const status = flight.valid ? "ok" : "TAMPERED";
        lines.push(`  ${status} ${flight.id} ${flight.name} (${flight.events} событий)`);
        for (const error of flight.errors)
            lines.push(`    ${error}`);
    }
    return lines.join("\n");
}
export function renderFlightVerify(result) {
    if (result.valid)
        return `[FLIGHT VALID] ${result.events} событий, цепочка цела.`;
    return [`[FLIGHT TAMPERED] ${result.errors.length} ошибок.`, ...result.errors.map((error) => `  ${error}`)].join("\n");
}
export function renderFlightStart(session) {
    return `Полёт ${session.meta.id} начат (${session.meta.name}).`;
}
export function renderFlightCheckpoint(checkpoint) {
    return `Чекпоинт ${checkpoint.label}: ${checkpoint.commit.slice(0, 12)} (tree ${checkpoint.tree.slice(0, 12)}).`;
}
export function renderFlightExec(result) {
    const status = result.timedOut ? "таймаут" : `код ${result.exitCode ?? "?"}`;
    return `Команда ${result.command.join(" ")}: ${status}, ${result.durationMs} мс.`;
}
export function renderFlightEnd(summary) {
    return `Полёт завершён: чекпоинтов ${String(summary.checkpoints ?? 0)}, команд ${String(summary.commands ?? 0)}, ${String(summary.durationMs ?? 0)} мс.`;
}
function resolveFlightId(cwd, id) {
    if (id && id.trim().length > 0)
        return id.trim();
    const active = activeFlight(cwd);
    if (active)
        return active.meta.id;
    const latest = listFlights(cwd)[0];
    if (latest)
        return latest.id;
    throw new PilotError("Полёт не запущен.", {
        hint: "Запустите oc-pilot flight start или укажите --id.",
        exitCode: 2,
    });
}
function flightCheckpoints(show) {
    return show.events
        .filter((event) => event.kind === "file.checkpoint")
        .map((event) => event.payload);
}
function resolveCheckpoint(checkpoints, ref) {
    if (checkpoints.length === 0) {
        throw new PilotError("В полёте нет чекпоинтов.", {
            hint: "Создайте чекпоинт: oc-pilot flight checkpoint --label <метка>.",
            exitCode: 2,
        });
    }
    if (!ref)
        return checkpoints[checkpoints.length - 1];
    const exact = [...checkpoints].reverse().find((checkpoint) => checkpoint.label === ref);
    if (exact)
        return exact;
    const byCommit = [...checkpoints].reverse().find((checkpoint) => checkpoint.commit.startsWith(ref));
    if (byCommit)
        return byCommit;
    throw new PilotError(`Чекпоинт не найден: ${ref}.`, {
        hint: "Посмотрите oc-pilot flight show <id>.",
        exitCode: 2,
    });
}
function sanitizeLabel(label) {
    return label.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40) || "checkpoint";
}
function removeWorktree(cwd, path) {
    const result = runGit(["worktree", "remove", "--force", path], cwd);
    if (result.status !== 0)
        rmSync(path, { recursive: true, force: true });
}
export function replayFlight(cwd, id, to, path) {
    const show = showFlight(cwd, resolveFlightId(cwd, id));
    const checkpoint = resolveCheckpoint(flightCheckpoints(show), to);
    const target = path
        ? resolve(cwd, path)
        : join(tmpdir(), `oc-pilot-flight-${show.meta.id}-${sanitizeLabel(checkpoint.label)}-${randomBytes(3).toString("hex")}`);
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
export function restoreFlight(cwd, ref, id, force = false, dryRun = false) {
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
export function bisectFlight(cwd, id, command, timeoutMs = 600_000) {
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
            exitCode: 2,
        });
    }
    const steps = [];
    let firstBad;
    for (const checkpoint of checkpoints) {
        const replay = replayFlight(cwd, show.meta.id, checkpoint.commit);
        const startedAt = Date.now();
        const result = spawnSync(command[0], command.slice(1), {
            cwd: replay.path,
            encoding: "utf8",
            timeout: timeoutMs,
            maxBuffer: 16 * 1024 * 1024,
            windowsHide: true,
        });
        const errorCode = result.error?.code;
        const timedOut = errorCode === "ETIMEDOUT" || result.signal === "SIGTERM";
        const exitCode = typeof result.status === "number" ? result.status : null;
        const step = {
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
export function diffFlight(cwd, id, fromRef, toRef) {
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
function commandKey(command) {
    return JSON.stringify(command);
}
function commandLabel(command) {
    const text = command.join(" ");
    return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}
function compareSide(show) {
    const events = show.events;
    const startedAt = show.meta.startedAt;
    const endedAt = events.at(-1)?.ts ?? startedAt;
    const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
    const checkpoints = flightCheckpoints(show);
    const last = checkpoints.at(-1);
    const runs = new Map();
    for (const event of events) {
        if (event.kind !== "command.end")
            continue;
        const payload = event.payload;
        const command = Array.isArray(payload.command)
            ? payload.command.filter((part) => typeof part === "string")
            : [];
        if (command.length === 0)
            continue;
        const run = {
            command,
            exitCode: typeof payload.exitCode === "number" ? payload.exitCode : null,
            timedOut: payload.timedOut === true,
            durationMs: typeof payload.durationMs === "number" ? payload.durationMs : 0,
        };
        runs.set(commandKey(command), run);
    }
    const failedCommands = [...runs.values()].filter((run) => run.timedOut || (run.exitCode !== null && run.exitCode !== 0)).length;
    const side = {
        id: show.meta.id,
        name: show.meta.name,
        startedAt,
        endedAt,
        durationMs,
        events: events.length,
        notes: events.filter((event) => event.kind === "note").length,
        commands: events.filter((event) => event.kind === "command.start").length,
        checkpoints: checkpoints.length,
        failedCommands,
        valid: show.verification.valid,
        baseCommit: show.meta.baseCommit,
        finalCheckpoint: last ? { label: last.label, commit: last.commit, tree: last.tree } : undefined,
    };
    return { side, runs };
}
export function compareFlights(cwd, idA, idB) {
    return compareFlightShows(showFlight(cwd, idA), showFlight(cwd, idB));
}
export function compareFlightShows(showA, showB) {
    const left = compareSide(showA);
    const right = compareSide(showB);
    const common = [];
    const onlyA = [];
    const onlyB = [];
    for (const [key, run] of left.runs) {
        if (right.runs.has(key))
            common.push(run.command);
        else
            onlyA.push(run.command);
    }
    for (const [key, run] of right.runs) {
        if (!left.runs.has(key))
            onlyB.push(run.command);
    }
    const exitCodeDifferences = [];
    for (const [key, leftRun] of left.runs) {
        const rightRun = right.runs.get(key);
        if (!rightRun)
            continue;
        if (leftRun.exitCode !== rightRun.exitCode || leftRun.timedOut !== rightRun.timedOut) {
            exitCodeDifferences.push({
                command: leftRun.command,
                a: leftRun.timedOut ? null : leftRun.exitCode,
                b: rightRun.timedOut ? null : rightRun.exitCode,
            });
        }
    }
    const sameFinalTree = left.side.finalCheckpoint && right.side.finalCheckpoint
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
const SECRET_PATTERNS = [
    /sk-[A-Za-z0-9]{20,}/g,
    /gh[pousr]_[A-Za-z0-9]{20,}/g,
    /xox[baprs]-[A-Za-z0-9-]{10,}/g,
    /AKIA[0-9A-Z]{16}/g,
    /((?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?)[^"'\s]{8,}/gi,
];
function redactText(text) {
    let output = text;
    for (const pattern of SECRET_PATTERNS) {
        output = output.replace(pattern, (_match, prefix) => typeof prefix === "string" && prefix.length > 0 ? `${prefix}[REDACTED]` : "[REDACTED]");
    }
    return output;
}
function redactValue(value) {
    if (typeof value === "string")
        return redactText(value);
    if (Array.isArray(value))
        return value.map(redactValue);
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactValue(entry)]));
    }
    return value;
}
function flightBundleDigest(manifest) {
    return `sha256:${createHash("sha256").update(JSON.stringify(manifest)).digest("hex")}`;
}
function hmacFlightDigest(key, digest) {
    return createHmac("sha256", key).update(digest).digest("hex");
}
export function generateFlightKey() {
    return randomBytes(32).toString("hex");
}
export function exportFlight(cwd, id, keyPath) {
    const show = showFlight(cwd, resolveFlightId(cwd, id));
    const base = show.meta.baseCommit ?? "HEAD";
    const checkpoints = flightCheckpoints(show).map((checkpoint) => {
        const patch = runGit(["diff", "--no-color", base, checkpoint.commit], cwd);
        return {
            ...checkpoint,
            patch: patch.status === 0 ? redactText(patch.stdout) : "",
        };
    });
    const manifest = {
        format: "oc-pilot-flight-export/v1",
        exportedAt: new Date().toISOString(),
        meta: { ...show.meta, cwd: "." },
        verification: show.verification,
        events: show.events.map((event) => redactValue(event)),
        checkpoints,
    };
    const digest = flightBundleDigest(manifest);
    const result = { ...manifest, digest };
    if (keyPath) {
        result.signature = {
            type: "hmac-sha256",
            value: hmacFlightDigest(readFileSync(keyPath), digest),
        };
    }
    return result;
}
export function loadFlightBundle(file) {
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(file, "utf8"));
    }
    catch (error) {
        throw new PilotError(`Не удалось прочитать flight bundle: ${error instanceof Error ? error.message : String(error)}`, {
            hint: "Передайте JSON-файл, созданный oc-pilot flight export.",
            exitCode: 2,
        });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new PilotError("Flight bundle должен быть JSON-объектом.", {
            hint: "Передайте файл, созданный oc-pilot flight export.",
            exitCode: 2,
        });
    }
    const bundle = parsed;
    if (typeof bundle.format !== "string" ||
        typeof bundle.digest !== "string" ||
        !bundle.meta ||
        typeof bundle.meta !== "object" ||
        !Array.isArray(bundle.events)) {
        throw new PilotError("Flight bundle повреждён: нет обязательных полей.", {
            hint: "Передайте файл, созданный oc-pilot flight export.",
            exitCode: 2,
        });
    }
    return bundle;
}
export function signFlightBundle(bundle, keyPath) {
    const { digest, signature: _signature, ...base } = bundle;
    if (flightBundleDigest(base) !== digest) {
        throw new PilotError("Flight bundle повреждён: digest не совпадает.", {
            hint: "Не подписывайте изменённый bundle; сначала проверьте его через flight verify-bundle.",
            exitCode: 2,
        });
    }
    return {
        ...base,
        digest,
        signature: { type: "hmac-sha256", value: hmacFlightDigest(readFileSync(keyPath), digest) },
    };
}
export function flightShowFromBundle(bundle) {
    return {
        meta: bundle.meta,
        events: bundle.events,
        verification: verifyFlightEvents(bundle.events),
    };
}
export function verifyFlightBundle(file, keyPath) {
    const bundle = loadFlightBundle(file);
    const { digest, signature, ...base } = bundle;
    const digestOk = flightBundleDigest(base) === digest;
    const chain = verifyFlightEvents(bundle.events);
    const errors = [];
    if (!digestOk)
        errors.push("digest не совпадает");
    if (!chain.valid)
        errors.push(...chain.errors);
    let signatureStatus = "missing";
    if (signature !== undefined) {
        if (typeof signature !== "object" ||
            signature === null ||
            signature.type !== "hmac-sha256" ||
            typeof signature.value !== "string") {
            signatureStatus = "invalid";
            errors.push("неизвестный формат подписи");
        }
        else if (!keyPath) {
            signatureStatus = "unchecked";
            errors.push("подпись есть, но ключ не указан");
        }
        else {
            const expected = Buffer.from(hmacFlightDigest(readFileSync(keyPath), digest), "hex");
            const actual = Buffer.from(signature.value, "hex");
            signatureStatus =
                expected.length === actual.length && timingSafeEqual(expected, actual) ? "valid" : "invalid";
            if (signatureStatus === "invalid")
                errors.push("подпись не совпадает");
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
export function renderFlightReplay(result) {
    return `[FLIGHT REPLAY] ${result.label} (${result.commit.slice(0, 12)}) → ${result.path}`;
}
export function renderFlightRestore(result) {
    const files = result.files.length > 0 ? `: ${result.files.join(", ")}` : "";
    return `[FLIGHT RESTORE] ${result.dryRun ? "будет восстановлено" : "восстановлено"} ${result.label} (${result.commit.slice(0, 12)})${files}`;
}
export function renderFlightBisect(result) {
    const lines = [`[FLIGHT BISECT] ${result.id}: ${result.steps.length} чекпоинтов.`];
    for (const step of result.steps) {
        const marker = step === result.firstBad ? "FAIL" : "ok";
        lines.push(`  ${marker} ${step.label} ${step.commit.slice(0, 12)} exit ${step.exitCode ?? "?"}${step.timedOut ? " timeout" : ""}`);
    }
    if (result.firstBad) {
        lines.push(`[FIRST BAD STEP] ${result.firstBad.label} (${result.firstBad.commit.slice(0, 12)}).`);
    }
    else {
        lines.push("[FLIGHT BISECT] все чекпоинты прошли.");
    }
    return lines.join("\n");
}
export function renderFlightDiff(result) {
    return [`[FLIGHT DIFF] ${result.from.label}..${result.to.label}`, result.stat, result.patch]
        .filter((part) => part.length > 0)
        .join("\n");
}
export function renderFlightCompareHtml(result) {
    const side = (label, value) => `<section class="card">
<h2>${label}: ${escapeHtml(value.name)}</h2>
<p class="id">${escapeHtml(value.id)}</p>
<span class="badge ${value.valid ? "ok" : "bad"}">${value.valid ? "chain valid" : "chain tampered"}</span>
<dl>
<div><dt>Events</dt><dd>${value.events}</dd></div>
<div><dt>Notes</dt><dd>${value.notes}</dd></div>
<div><dt>Commands</dt><dd>${value.commands}</dd></div>
<div><dt>Checkpoints</dt><dd>${value.checkpoints}</dd></div>
<div><dt>Failed commands</dt><dd>${value.failedCommands}</dd></div>
<div><dt>Duration</dt><dd>${value.durationMs} ms</dd></div>
</dl>
</section>`;
    const commandList = (commands) => commands.length === 0
        ? `<p class="muted">none</p>`
        : `<ul>${commands.map((command) => `<li><code>${escapeHtml(commandLabel(command))}</code></li>`).join("")}</ul>`;
    const differences = result.exitCodeDifferences.length === 0
        ? `<p class="muted">none</p>`
        : `<table><thead><tr><th>Command</th><th>A</th><th>B</th></tr></thead><tbody>${result.exitCodeDifferences
            .map((difference) => `<tr><td><code>${escapeHtml(commandLabel(difference.command))}</code></td><td>${difference.a ?? "?"}</td><td>${difference.b ?? "?"}</td></tr>`)
            .join("")}</tbody></table>`;
    const tree = result.sameFinalTree === null
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
export function renderFlightExport(result) {
    return `[FLIGHT EXPORT] ${result.meta.id}: ${result.events.length} событий, ${result.checkpoints.length} чекпоинтов, ${result.digest.slice(0, 19)}.`;
}
export function renderFlightBundleVerify(result) {
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
function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => {
        if (character === "&")
            return "&amp;";
        if (character === "<")
            return "&lt;";
        if (character === ">")
            return "&gt;";
        if (character === '"')
            return "&quot;";
        return "&#39;";
    });
}
function htmlEventDetail(event) {
    const payload = event.payload;
    if (event.kind === "command.end") {
        const parts = [`exit ${String(payload.exitCode ?? "?")}`];
        if (payload.timedOut === true)
            parts.push("timeout");
        if (typeof payload.durationMs === "number")
            parts.push(`${payload.durationMs} ms`);
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
function htmlEventOutput(event) {
    const payload = event.payload;
    const blocks = [];
    for (const [label, key] of [
        ["stdout", "stdoutTail"],
        ["stderr", "stderrTail"],
    ]) {
        const value = payload[key];
        if (typeof value === "string" && value.trim().length > 0) {
            blocks.push(`<details><summary>${label}</summary><pre>${escapeHtml(value)}</pre></details>`);
        }
    }
    return blocks.join("");
}
export function renderFlightHtml(result) {
    const meta = result.meta;
    const verification = verifyFlightEvents(result.events);
    const checkpointRows = result.checkpoints.length === 0
        ? `<tr><td colspan="4" class="muted">No checkpoints.</td></tr>`
        : result.checkpoints
            .map((checkpoint) => `<tr>
<td>${escapeHtml(checkpoint.label)}</td>
<td><code>${escapeHtml(checkpoint.commit.slice(0, 12))}</code></td>
<td>${escapeHtml(checkpoint.createdAt)}</td>
<td>${checkpoint.patch.trim().length > 0
            ? `<details><summary>patch</summary><pre>${escapeHtml(checkpoint.patch)}</pre></details>`
            : `<span class="muted">—</span>`}</td>
</tr>`)
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
    const errors = verification.valid
        ? ""
        : `<section class="errors"><h2>Chain errors</h2><ul>${verification.errors
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
<span class="badge ${verification.valid ? "ok" : "bad"}">${verification.valid ? "chain valid" : "chain tampered"}</span>
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
export function renderFlightCompare(result) {
    const side = (label, value) => `${label}: ${value.name} (${value.id}) - событий ${value.events}, заметок ${value.notes}, команд ${value.commands}, ` +
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
            lines.push(`  ${commandLabel(difference.command)}: A ${difference.a ?? "?"}, B ${difference.b ?? "?"}`);
        }
    }
    lines.push(`Итоговое дерево: ${result.sameFinalTree === null
        ? "нет чекпоинтов у одного из полётов"
        : result.sameFinalTree
            ? "совпадает"
            : "различается"}.`);
    return lines.join("\n");
}
//# sourceMappingURL=flight.js.map