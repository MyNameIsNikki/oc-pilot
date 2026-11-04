import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { PilotError } from "./errors.js";
import { getRepoRoot, isGitRepo, runGit } from "./git.js";
export const RECEIPT_VERSION = 1;
/** Stable digest of the receipt body; the hash field itself is excluded. */
export function receiptHash(body) {
    return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}
export function buildReceipt(body) {
    return { ...body, hash: receiptHash(body) };
}
function gitValue(cwd, args) {
    const result = runGit(args, cwd);
    if (result.status !== 0)
        return null;
    const value = result.stdout.trim();
    return value === "" ? null : value;
}
/** Current HEAD, branch and dirty flag, recorded so a receipt can be matched to a checkout. */
export function gitSnapshot(cwd) {
    const commit = gitValue(cwd, ["rev-parse", "HEAD"]);
    const branch = gitValue(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const status = runGit(["status", "--porcelain"], cwd);
    return {
        commit,
        branch,
        dirty: status.status === 0 && status.stdout.trim() !== "",
    };
}
function gitDir(cwd) {
    if (!isGitRepo(cwd))
        return undefined;
    const repoRoot = getRepoRoot(cwd);
    const result = runGit(["rev-parse", "--git-dir"], repoRoot);
    if (result.status !== 0)
        return undefined;
    const raw = result.stdout.trim();
    return /^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(raw) ? raw : join(repoRoot, raw);
}
/**
 * The default store lives inside `.git`, so receipts never show up as
 * untracked files and never leak into a commit by accident.
 */
export function receiptPath(cwd) {
    const dir = gitDir(cwd);
    return dir ? join(dir, "oc-pilot", "receipt.json") : undefined;
}
export function saveReceipt(cwd, receipt, outputPath) {
    const target = outputPath ?? receiptPath(cwd);
    if (!target) {
        throw new PilotError("Вне git-репозитория квитанцию можно сохранить только через --out", {
            hint: "Укажите --out <file> или запустите команду в git-репозитории.",
            exitCode: 2,
        });
    }
    const resolved = isAbsolute(target) ? target : join(cwd, target);
    mkdirSync(dirname(resolved), { recursive: true });
    writeFileSync(resolved, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    return resolved;
}
export function readReceipt(path) {
    if (!existsSync(path)) {
        throw new PilotError(`Квитанция не найдена: ${path}`, {
            hint: "Сначала выполните `oc-pilot receipt`, затем проверяйте сохранённый файл.",
            exitCode: 2,
        });
    }
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        throw new PilotError(`Не удалось прочитать квитанцию: ${path}`, {
            hint: "Файл повреждён или это не JSON.",
            exitCode: 2,
        });
    }
    if (typeof parsed !== "object" ||
        parsed === null ||
        typeof parsed.hash !== "string" ||
        typeof parsed.version !== "number") {
        throw new PilotError(`Не удалось прочитать квитанцию: ${path}`, {
            hint: "Файл не похож на квитанцию oc-pilot.",
            exitCode: 2,
        });
    }
    return parsed;
}
export function verifyReceipt(cwd, receipt) {
    const { hash, ...body } = receipt;
    const hashOk = hash === receiptHash(body);
    const head = gitValue(cwd, ["rev-parse", "HEAD"]);
    const stale = receipt.commit !== null && head !== null && receipt.commit !== head;
    let reason;
    if (receipt.version !== RECEIPT_VERSION) {
        reason = `версия квитанции ${receipt.version}, ожидается ${RECEIPT_VERSION}`;
    }
    else if (!hashOk) {
        reason = "хеш не совпадает: файл изменён после создания";
    }
    else if (stale) {
        reason = `квитанция выдана для ${receipt.commit?.slice(0, 12)}, а HEAD сейчас ${head?.slice(0, 12)}`;
    }
    return { ok: hashOk && !stale && reason === undefined, hashOk, stale, commit: receipt.commit, head, reason };
}
/** Human-readable summary printed after a receipt is created or checked. */
export function renderReceipt(receipt, savedPath) {
    const lines = [
        `Квитанция: ${receipt.commit?.slice(0, 12) ?? "без коммита"} (${receipt.branch ?? "detached"}, ${receipt.dirty ? "рабочее дерево изменено" : "чистое дерево"})`,
        `Дифф: ${receipt.diff.files} файл(ов), +${receipt.diff.additions} / -${receipt.diff.deletions}`,
    ];
    if (receipt.tests) {
        lines.push(`Тесты: ${receipt.tests.command} — ${receipt.tests.passed ? "пройдены" : "провалены"} (${receipt.tests.durationMs} мс)`);
    }
    else {
        lines.push("Тесты: не запускались");
    }
    const failed = receipt.preflight.checks.filter((check) => check.status === "fail").length;
    const verdict = receipt.preflight.status === "pass" ? "пройден" : "провален";
    lines.push(`Preflight: ${verdict} — проверок с замечаниями: ${failed} из ${receipt.preflight.checks.length}`);
    lines.push(`Хеш: ${receipt.hash}`);
    if (savedPath)
        lines.push(`Сохранено: ${savedPath}`);
    return `${lines.join("\n")}\n`;
}
//# sourceMappingURL=receipt.js.map