import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, } from "node:crypto";
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
/** Signs the receipt hash with an Ed25519 private key in PEM (PKCS#8). */
export function signReceipt(body, privateKeyPem) {
    const receipt = buildReceipt(body);
    let signature;
    try {
        signature = sign(null, Buffer.from(receipt.hash, "utf8"), createPrivateKey(privateKeyPem)).toString("base64");
    }
    catch {
        throw new PilotError("Не удалось подписать квитанцию: некорректный приватный ключ", {
            hint: "Ожидается Ed25519-ключ в PEM (PKCS#8). Создайте пару: oc-pilot receipt --keygen <file>.",
            exitCode: 2,
        });
    }
    return { ...receipt, signature };
}
export function verifyReceiptSignature(receipt, publicKeyPem) {
    if (!receipt.signature)
        return false;
    try {
        return verify(null, Buffer.from(receipt.hash, "utf8"), createPublicKey(publicKeyPem), Buffer.from(receipt.signature, "base64"));
    }
    catch {
        return false;
    }
}
export function generateReceiptKeyPair() {
    const pair = generateKeyPairSync("ed25519");
    return {
        privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
}
/** Public key committed with the project, so CI and agents can verify receipts. */
export function receiptPublicKeyPath(cwd) {
    return join(cwd, ".oc-pilot", "receipt.pub");
}
export function readReceiptPublicKey(cwd) {
    const path = receiptPublicKeyPath(cwd);
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
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
export function verifyReceipt(cwd, receipt, publicKeyPem) {
    const { hash, signature, ...body } = receipt;
    const hashOk = hash === receiptHash(body);
    const head = gitValue(cwd, ["rev-parse", "HEAD"]);
    const stale = receipt.commit !== null && head !== null && receipt.commit !== head;
    const signatureStatus = publicKeyPem === undefined
        ? signature
            ? "unchecked"
            : "missing"
        : signature
            ? verifyReceiptSignature(receipt, publicKeyPem)
                ? "valid"
                : "invalid"
            : "missing";
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
    else if (publicKeyPem !== undefined && signatureStatus === "invalid") {
        reason = "подпись не совпадает: квитанция подписана другим ключом или изменена";
    }
    else if (publicKeyPem !== undefined && signatureStatus === "missing") {
        reason = "квитанция не подписана, а проверка требует подпись";
    }
    return {
        ok: hashOk && !stale && reason === undefined,
        hashOk,
        stale,
        commit: receipt.commit,
        head,
        signature: signatureStatus,
        reason,
    };
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
    if (receipt.signature)
        lines.push("Подпись: Ed25519");
    if (savedPath)
        lines.push(`Сохранено: ${savedPath}`);
    return `${lines.join("\n")}\n`;
}
//# sourceMappingURL=receipt.js.map