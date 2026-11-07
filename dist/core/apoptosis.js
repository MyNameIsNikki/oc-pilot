import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runShellCommand } from "./command.js";
import { PilotError } from "./errors.js";
import { runGit } from "./git.js";
import { applyShadowDiff, createShadow, shadowDiff } from "./shadow.js";
import { readRepository } from "./slop/collect.js";
import { isGeneratedPath, stripCode } from "./slop/source.js";
const MARKER = /@lifespan\s*:\s*(\d+)\s*d/i;
const FUNCTION = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/;
const ARROW = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/;
const FUNCTION_VALUE = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?function\b/;
function cleanMarkerLine(line) {
    return line.replace(/\/\*.*?\*\//g, " ").replace(/\/\/.*$/, "");
}
function parseFunction(line) {
    const cleaned = cleanMarkerLine(line);
    const fn = FUNCTION.exec(cleaned) ?? FUNCTION_VALUE.exec(cleaned);
    if (fn?.[1])
        return { symbol: fn[1], arrow: false };
    const arrow = ARROW.exec(cleaned);
    if (arrow?.[1])
        return { symbol: arrow[1], arrow: true };
    return undefined;
}
function findFunction(lines, markerIndex) {
    for (let at = markerIndex; at < Math.min(lines.length, markerIndex + 5); at += 1) {
        if (at !== markerIndex && MARKER.test(lines[at]))
            continue;
        const parsed = parseFunction(lines[at]);
        if (parsed)
            return { line: at + 1, ...parsed };
    }
    return undefined;
}
function findEndLine(lines, start, arrow) {
    const first = lines[start];
    if (arrow && !/\{/.test(first.slice(first.indexOf("=>") + 2))) {
        for (let at = start; at < Math.min(lines.length, start + 30); at += 1) {
            if (/;\s*$/.test(lines[at]))
                return at + 1;
        }
        return start + 1;
    }
    const stripped = stripCode(lines.slice(start).join("\n"), "apoptosis.ts").split("\n");
    let depth = 0;
    let opened = false;
    for (let at = 0; at < stripped.length; at += 1) {
        for (const char of stripped[at]) {
            if (char === "{") {
                depth += 1;
                opened = true;
            }
            else if (char === "}") {
                depth -= 1;
                if (opened && depth <= 0)
                    return start + at + 1;
            }
        }
    }
    return start + 1;
}
function blameTime(cwd, file, line) {
    const result = runGit(["blame", "-L", `${String(line)},${String(line)}`, "--porcelain", "--", file], cwd);
    if (result.status !== 0)
        return undefined;
    const match = /^author-time (\d+)$/m.exec(result.stdout);
    return match?.[1] ? Number(match[1]) : undefined;
}
function countReferences(files, entry) {
    const escaped = entry.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\b${escaped}\\b`, "g");
    let count = 0;
    for (const file of files) {
        if (isGeneratedPath(file.path))
            continue;
        const lines = stripCode(file.text, file.path).split("\n");
        for (let at = 0; at < lines.length; at += 1) {
            const lineNo = at + 1;
            if (file.path === entry.file && (lineNo === entry.line || lineNo === entry.markerLine))
                continue;
            count += lines[at].match(pattern)?.length ?? 0;
        }
    }
    return count;
}
export function scanApoptosis(cwd, options = {}) {
    const repository = readRepository(cwd);
    const now = (options.now ?? new Date()).getTime();
    const entries = [];
    for (const file of repository.files) {
        if (isGeneratedPath(file.path))
            continue;
        const lines = file.text.split("\n");
        for (let at = 0; at < lines.length; at += 1) {
            const marker = MARKER.exec(lines[at]);
            if (!marker?.[1])
                continue;
            const found = findFunction(lines, at);
            if (!found)
                continue;
            const endLine = findEndLine(lines, found.line - 1, found.arrow);
            const markerTime = blameTime(cwd, file.path, at + 1);
            const ageDays = markerTime === undefined ? 0 : Math.max(0, Math.floor((now - markerTime * 1000) / 86_400_000));
            const lifespanDays = Number(marker[1]);
            const entry = {
                file: file.path,
                markerLine: at + 1,
                line: found.line,
                endLine,
                symbol: found.symbol,
                lifespanDays,
                ageDays,
                references: 0,
                status: "alive",
            };
            entry.references = countReferences(repository.files, entry);
            entry.status = ageDays >= lifespanDays && entry.references === 0 ? "senescent" : "alive";
            entries.push(entry);
        }
    }
    entries.sort((left, right) => left.file.localeCompare(right.file) || left.markerLine - right.markerLine);
    const senescent = entries.filter((entry) => entry.status === "senescent").length;
    const summary = senescent === 0
        ? "Сенесцентных функций нет: все маркеры @lifespan ещё активны."
        : `Найдено сенесцентных функций: ${String(senescent)}.`;
    const content = [
        `Apoptosis: ${String(entries.length)} marker(s), ${String(senescent)} senescent`,
        ...entries.map((entry) => {
            const tag = entry.status === "senescent" ? "[Senescent]" : "[Alive]";
            return `${tag} ${entry.file}:${String(entry.line)} ${entry.symbol} — ${String(entry.ageDays)}/${String(entry.lifespanDays)} d, refs ${String(entry.references)}`;
        }),
        summary,
    ].join("\n");
    return { entries, senescent, scannedFiles: repository.files.length, summary, content: `${content}\n` };
}
export function renderApoptosis(report) {
    return report.content;
}
function commentOut(lines, entry) {
    const start = entry.markerLine - 1;
    const end = entry.endLine - 1;
    const body = lines.slice(start, end + 1).map((line) => `// ${line}`);
    lines.splice(start, end - start + 1, `// [apoptosis] ${entry.symbol} removed after ${String(entry.ageDays)} days without references`, ...body);
}
export async function applyApoptosis(cwd, options) {
    if (!options.confirm) {
        throw new PilotError("apoptosis apply требует --confirm", {
            hint: "Сначала посмотрите отчёт scan, затем повторите с --confirm.",
            exitCode: 2,
        });
    }
    const report = scanApoptosis(cwd);
    const targets = report.entries.filter((entry) => entry.status === "senescent");
    if (targets.length === 0) {
        return { status: "nothing", removed: [], testCommand: options.command, summary: "Сенесцентных функций нет — удалять нечего." };
    }
    const shadow = createShadow(cwd);
    try {
        const byFile = new Map();
        for (const entry of targets) {
            const list = byFile.get(entry.file) ?? [];
            list.push(entry);
            byFile.set(entry.file, list);
        }
        for (const [file, entries] of byFile) {
            const path = join(shadow.dir, file);
            if (!existsSync(path))
                continue;
            const lines = readFileSync(path, "utf8").split("\n");
            for (const entry of [...entries].sort((left, right) => right.markerLine - left.markerLine)) {
                commentOut(lines, entry);
            }
            writeFileSync(path, lines.join("\n"), "utf8");
        }
        const run = await runShellCommand(options.command, shadow.dir, { timeoutMs: options.timeoutMs ?? 120_000 });
        if (run.exitCode !== 0 || run.timedOut) {
            return {
                status: "tests-failed",
                removed: [],
                testCommand: options.command,
                exitCode: run.exitCode,
                output: run.output.slice(-4_000),
                summary: run.timedOut ? "Тесты не успели завершиться — изменения не применены." : "Тесты упали — изменения не применены.",
            };
        }
        const applied = applyShadowDiff(cwd, shadowDiff(shadow.dir));
        if (!applied.ok) {
            return {
                status: "apply-failed",
                removed: [],
                testCommand: options.command,
                exitCode: 1,
                output: applied.error,
                summary: `Не удалось применить diff: ${applied.error ?? "unknown"}`,
            };
        }
        return {
            status: "applied",
            removed: targets,
            testCommand: options.command,
            exitCode: 0,
            summary: `Удалено сенесцентных функций: ${String(targets.length)}; тесты зелёные.`,
        };
    }
    finally {
        shadow.cleanup();
    }
}
//# sourceMappingURL=apoptosis.js.map