import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PilotError } from "./errors.js";
export const QUARANTINE_STORE = ".oc-pilot/quarantine.json";
const STORE_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
export function quarantinePath(cwd) {
    return join(cwd, ".oc-pilot", "quarantine.json");
}
function emptyStore() {
    return { version: STORE_VERSION, entries: [] };
}
export function readQuarantine(cwd) {
    const path = quarantinePath(cwd);
    if (!existsSync(path))
        return emptyStore();
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.entries))
            return emptyStore();
        const entries = parsed.entries.filter((item) => {
            if (!item || typeof item !== "object")
                return false;
            const record = item;
            return (typeof record.test === "string" &&
                typeof record.owner === "string" &&
                typeof record.reason === "string" &&
                typeof record.addedAt === "string" &&
                typeof record.expiresAt === "string");
        });
        return { version: STORE_VERSION, entries };
    }
    catch {
        return emptyStore();
    }
}
function writeQuarantine(cwd, store) {
    const path = quarantinePath(cwd);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}
export function addQuarantine(cwd, options) {
    const test = options.test.trim();
    const owner = options.owner.trim();
    const reason = options.reason.trim();
    if (!test || !owner || !reason) {
        throw new PilotError("Нужны --test, --owner и --reason", { exitCode: 2 });
    }
    if (!Number.isInteger(options.days) || options.days < 1 || options.days > 365) {
        throw new PilotError("--days должен быть целым от 1 до 365", { exitCode: 2 });
    }
    const store = readQuarantine(cwd);
    if (store.entries.some((entry) => entry.test === test)) {
        throw new PilotError(`Тест уже на карантине: ${test}`, {
            hint: "Сначала снимите его: oc-pilot quarantine remove --test <name>.",
            exitCode: 2,
        });
    }
    const now = options.now ?? new Date();
    const entry = {
        test,
        owner,
        reason,
        addedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + options.days * DAY_MS).toISOString(),
        issue: options.issue?.trim() || undefined,
    };
    writeQuarantine(cwd, { version: STORE_VERSION, entries: [...store.entries, entry] });
    return entry;
}
function daysLeft(entry, now) {
    return Math.ceil((new Date(entry.expiresAt).getTime() - now.getTime()) / DAY_MS);
}
export function listQuarantine(cwd, now = new Date()) {
    const entries = [...readQuarantine(cwd).entries].sort((left, right) => new Date(left.expiresAt).getTime() - new Date(right.expiresAt).getTime());
    const active = entries.filter((entry) => new Date(entry.expiresAt).getTime() > now.getTime());
    const expired = entries.filter((entry) => new Date(entry.expiresAt).getTime() <= now.getTime());
    const lines = [`Quarantine: ${String(entries.length)} тестов, active ${String(active.length)}, expired ${String(expired.length)}.`];
    if (entries.length === 0)
        lines.push("Карантин пуст.");
    for (const entry of entries) {
        const left = daysLeft(entry, now);
        const mark = left <= 0 ? "[EXPIRED]" : "[ACTIVE]";
        lines.push(`  ${mark} ${entry.test} — owner ${entry.owner}, ${left > 0 ? `${String(left)}d left` : `${String(-left)}d overdue`}, ${entry.reason}`);
        if (entry.issue)
            lines.push(`    ${entry.issue}`);
    }
    return { entries, active, expired, content: `${lines.join("\n")}\n` };
}
export function checkQuarantine(cwd, now = new Date()) {
    const list = listQuarantine(cwd, now);
    if (list.expired.length > 0) {
        const summary = `[QUARANTINE EXPIRED]: ${String(list.expired.length)} тестов просрочены: ${list.expired
            .slice(0, 5)
            .map((entry) => entry.test)
            .join(", ")}.`;
        return {
            status: "expired",
            expired: list.expired,
            summary,
            content: `${list.content}\n${summary}\n`,
        };
    }
    if (list.entries.length === 0) {
        const summary = "[QUARANTINE EMPTY]: карантин пуст.";
        return { status: "empty", expired: [], summary, content: `${summary}\n` };
    }
    const next = list.active[0];
    const summary = `[QUARANTINE ACTIVE]: ${String(list.active.length)} тестов на карантине; ближайший истекает ${next?.expiresAt ?? "unknown"}.`;
    return { status: "clean", expired: [], summary, content: `${list.content}\n${summary}\n` };
}
export function removeQuarantine(cwd, test) {
    const store = readQuarantine(cwd);
    const next = store.entries.filter((entry) => entry.test !== test);
    if (next.length === store.entries.length)
        return { removed: false, remaining: next.length };
    writeQuarantine(cwd, { version: STORE_VERSION, entries: next });
    return { removed: true, remaining: next.length };
}
export function clearQuarantine(cwd) {
    const store = readQuarantine(cwd);
    rmSync(quarantinePath(cwd), { force: true });
    return { removed: store.entries.length };
}
//# sourceMappingURL=quarantine.js.map