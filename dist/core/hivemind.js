import { createCipheriv, createDecipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes, sign, verify, } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { PilotError } from "./errors.js";
const ALLOWED_TYPES = new Set(["diff", "ast", "llm-request", "ping"]);
const DEFAULT_PORT = 41_337;
const DEFAULT_TIMEOUT_MS = 5_000;
export function hivemindDir(cwd) {
    return resolve(cwd, ".oc-pilot", "hivemind");
}
export function identityPath(cwd) {
    return join(hivemindDir(cwd), "identity.json");
}
export function peersPath(cwd) {
    return join(hivemindDir(cwd), "peers.json");
}
function exportPublic(key) {
    return key.export({ type: "spki", format: "der" }).toString("base64");
}
export function initIdentity(cwd, force = false) {
    const path = identityPath(cwd);
    if (existsSync(path) && !force)
        return readIdentity(cwd);
    const pair = generateKeyPairSync("ed25519");
    const identity = {
        publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString().trim(),
        privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim(),
        createdAt: new Date().toISOString(),
    };
    mkdirSync(hivemindDir(cwd), { recursive: true });
    writeFileSync(path, `${JSON.stringify(identity, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return identity;
}
export function readIdentity(cwd) {
    const path = identityPath(cwd);
    if (!existsSync(path))
        return undefined;
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        return { ...parsed, publicKey: parsed.publicKey.trim(), privateKey: parsed.privateKey.trim() };
    }
    catch {
        return undefined;
    }
}
export function readPeers(cwd) {
    const path = peersPath(cwd);
    if (!existsSync(path))
        return [];
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        return Array.isArray(parsed.peers) ? parsed.peers.filter((peer) => typeof peer === "string") : [];
    }
    catch {
        return [];
    }
}
export function trustPeer(cwd, publicKey) {
    const key = publicKey.trim();
    if (!key)
        throw new PilotError("Пустой публичный ключ", { exitCode: 2 });
    const peers = readPeers(cwd);
    if (!peers.includes(key))
        peers.push(key);
    mkdirSync(hivemindDir(cwd), { recursive: true });
    writeFileSync(peersPath(cwd), `${JSON.stringify({ peers }, null, 2)}\n`, "utf8");
    return peers;
}
export function isTrusted(cwd, publicKey) {
    return typeof publicKey === "string" && readPeers(cwd).includes(publicKey);
}
/** Only analysis payloads cross the mesh; executable commands are rejected. */
export function validatePayload(payload) {
    if (!payload || typeof payload !== "object")
        return { ok: false, error: "payload must be an object" };
    const record = payload;
    if (typeof record.type !== "string")
        return { ok: false, error: "payload.type is required" };
    if (!ALLOWED_TYPES.has(record.type))
        return { ok: false, error: `payload type "${record.type}" is not allowed` };
    if ("command" in record || "exec" in record || "script" in record) {
        return { ok: false, error: "executable payloads are forbidden over hivemind" };
    }
    return { ok: true };
}
function signEphemeral(ephemeral, privateKey) {
    return sign(null, Buffer.from(ephemeral, "base64"), privateKey).toString("base64");
}
function verifyHello(hello) {
    if (hello.type !== "hello" && hello.type !== "hello-ack")
        return false;
    if (typeof hello.publicKey !== "string" || typeof hello.ephemeral !== "string" || typeof hello.signature !== "string") {
        return false;
    }
    try {
        return verify(null, Buffer.from(hello.ephemeral, "base64"), hello.publicKey, Buffer.from(hello.signature, "base64"));
    }
    catch {
        return false;
    }
}
function sharedKey(privateKey, ephemeral) {
    const publicKey = createPublicKey({
        key: Buffer.from(ephemeral, "base64"),
        format: "der",
        type: "spki",
    });
    return createHash("sha256").update(diffieHellman({ privateKey, publicKey })).digest();
}
function encrypt(payload, key) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    return JSON.stringify({
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: data.toString("base64"),
    });
}
function decrypt(line, key) {
    const parsed = JSON.parse(line);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
    const text = Buffer.concat([decipher.update(Buffer.from(parsed.data, "base64")), decipher.final()]).toString("utf8");
    return JSON.parse(text);
}
function writeLine(socket, value) {
    socket.write(`${JSON.stringify(value)}\n`);
}
function writeRawLine(socket, value) {
    socket.write(`${value}\n`);
}
async function nextLine(iterator) {
    const next = await iterator.next();
    if (next.done || next.value === undefined)
        throw new PilotError("Соединение закрыто до завершения handshake", { exitCode: 1 });
    return next.value;
}
/** Encrypted TCP mesh server; peers must be explicitly trusted. */
export async function startServer(cwd, options) {
    const identity = readIdentity(cwd);
    if (!identity) {
        throw new PilotError("Сначала выполните oc-pilot hivemind init", { exitCode: 2 });
    }
    const server = createServer((socket) => {
        void (async () => {
            const iterator = createInterface({ input: socket })[Symbol.asyncIterator]();
            try {
                const first = JSON.parse(await nextLine(iterator));
                if (!verifyHello(first) || !isTrusted(cwd, first.publicKey)) {
                    writeLine(socket, { type: "denied", error: "unknown or untrusted peer" });
                    socket.end();
                    return;
                }
                const ephemeral = generateKeyPairSync("x25519");
                const publicEphemeral = exportPublic(ephemeral.publicKey);
                writeLine(socket, {
                    type: "hello-ack",
                    publicKey: identity.publicKey,
                    ephemeral: publicEphemeral,
                    signature: signEphemeral(publicEphemeral, identity.privateKey),
                });
                const key = sharedKey(ephemeral.privateKey, first.ephemeral);
                for await (const line of iterator) {
                    try {
                        const payload = decrypt(line, key);
                        const check = validatePayload(payload);
                        if (!check.ok) {
                            writeRawLine(socket, encrypt({ type: "error", error: check.error }, key));
                            continue;
                        }
                        options.onMessage(payload);
                        writeRawLine(socket, encrypt({ type: "ack", received: payload.type }, key));
                    }
                    catch (error) {
                        writeRawLine(socket, encrypt({ type: "error", error: error instanceof Error ? error.message : String(error) }, key));
                    }
                }
            }
            catch {
                socket.end();
            }
        })();
    });
    const port = options.port ?? DEFAULT_PORT;
    const host = options.host ?? "127.0.0.1";
    await new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolveListen());
    });
    const address = server.address();
    const boundPort = typeof address === "object" && address ? address.port : port;
    return {
        port: boundPort,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
    };
}
/** Connects, performs the signed ECDH handshake and sends one encrypted payload. */
export async function sendMessage(cwd, options) {
    const check = validatePayload(options.payload);
    if (!check.ok)
        return { ok: false, error: check.error };
    const identity = readIdentity(cwd);
    if (!identity)
        return { ok: false, error: "identity missing: run hivemind init" };
    const host = options.host ?? "127.0.0.1";
    const socket = connect({ host, port: options.port });
    const timeout = Math.max(100, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
        await new Promise((resolveConnect, reject) => {
            const timer = setTimeout(() => reject(new Error("connect timeout")), timeout);
            socket.once("connect", () => {
                clearTimeout(timer);
                resolveConnect();
            });
            socket.once("error", (error) => {
                clearTimeout(timer);
                reject(error);
            });
        });
        const ephemeral = generateKeyPairSync("x25519");
        const publicEphemeral = exportPublic(ephemeral.publicKey);
        writeLine(socket, {
            type: "hello",
            publicKey: identity.publicKey,
            ephemeral: publicEphemeral,
            signature: signEphemeral(publicEphemeral, identity.privateKey),
        });
        const iterator = createInterface({ input: socket })[Symbol.asyncIterator]();
        const ack = JSON.parse(await nextLine(iterator));
        if (ack.type === "denied")
            return { ok: false, error: ack.error ?? "peer denied" };
        if (!verifyHello(ack) || !isTrusted(cwd, ack.publicKey)) {
            return { ok: false, error: "server is not trusted" };
        }
        const key = sharedKey(ephemeral.privateKey, ack.ephemeral);
        writeRawLine(socket, encrypt(options.payload, key));
        const response = decrypt(await nextLine(iterator), key);
        return { ok: response.type === "ack", response };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    finally {
        socket.end();
    }
}
//# sourceMappingURL=hivemind.js.map