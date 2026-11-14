import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
            ended: events.some((event) => event.kind === "session.end"),
        });
    }
    return entries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
export function showFlight(cwd, id) {
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
export function flightStatus(cwd) {
    const session = activeFlight(cwd);
    if (!session)
        return { active: false };
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
export function renderFlightStatus(status) {
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
export function renderFlightList(flights) {
    if (flights.length === 0)
        return "Полётов пока нет.";
    return flights
        .map((flight) => `${flight.id}  ${flight.ended ? "завершён" : "активен"}  ${flight.name}  событий ${flight.events}, чекпоинтов ${flight.checkpoints}`)
        .join("\n");
}
function eventSummary(event) {
    if (event.kind === "file.checkpoint") {
        return `чекпоинт ${String(event.payload.label ?? "")} (${String(event.payload.commit ?? "").slice(0, 8)})`;
    }
    if (event.kind === "command.start" || event.kind === "command.end") {
        const command = Array.isArray(event.payload.command) ? event.payload.command.join(" ") : "";
        return `${command}${event.kind === "command.end" ? ` → ${String(event.payload.exitCode ?? "?")}` : ""}`;
    }
    return String(event.payload.name ?? event.kind);
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
    if (!active) {
        throw new PilotError("Полёт не запущен.", {
            hint: "Запустите oc-pilot flight start или укажите --id.",
        });
    }
    return active.meta.id;
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
export function exportFlight(cwd, id) {
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
    const digest = `sha256:${createHash("sha256").update(JSON.stringify(manifest)).digest("hex")}`;
    return { ...manifest, digest };
}
export function renderFlightReplay(result) {
    return `[FLIGHT REPLAY] ${result.label} (${result.commit.slice(0, 12)}) → ${result.path}`;
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
export function renderFlightExport(result) {
    return `[FLIGHT EXPORT] ${result.meta.id}: ${result.events.length} событий, ${result.checkpoints.length} чекпоинтов, ${result.digest.slice(0, 19)}.`;
}
//# sourceMappingURL=flight.js.map