import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PilotError } from "../core/errors.js";
import { initIdentity, readIdentity, readPeers, sendMessage, startServer, trustPeer, validatePayload, } from "../core/hivemind.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";
const OPTIONS = withCommon({
    port: { type: "string" },
    host: { type: "string" },
    type: { type: "string" },
    payload: { type: "string" },
    force: { type: "boolean" },
});
const HELP = `Использование:
  oc-pilot hivemind init [--force]
  oc-pilot hivemind trust <public-key|file>
  oc-pilot hivemind status [--json]
  oc-pilot hivemind serve [--port 41337]
  oc-pilot hivemind send --port 41337 --type diff --payload @changes.diff

P2P-сеть агентов на встроенном node:net. Узлы обмениваются только
диффами, AST и запросами к LLM; исполняемые команды запрещены. Каждое
соединение проходит подписанный ed25519 handshake и ECDH X25519, а
сообщения шифруются AES-256-GCM. Без ключа проекта и явного trust
пакеты дропаются.

Опции:
      --port <n>          порт (по умолчанию 41337)
      --host <addr>       адрес (по умолчанию 127.0.0.1)
      --type <type>       diff, ast, llm-request или ping
      --payload <text|@file> тело сообщения
      --force             перевыпустить identity
${COMMON_HELP}

Примеры:
  oc-pilot hivemind init
  oc-pilot hivemind trust "-----BEGIN PUBLIC KEY-----..."
  oc-pilot hivemind serve --port 41337
  oc-pilot hivemind send --port 41337 --type diff --payload @changes.diff`;
function fingerprint(publicKey) {
    return createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
}
export async function runHivemind(argv) {
    const { values, positionals } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(HELP);
        return 0;
    }
    const [subcommand, argument] = positionals;
    const ctx = resolveContext(values);
    if (subcommand === "init") {
        const identity = initIdentity(ctx.cwd, asBoolean(values, "force"));
        log.success("Hivemind identity готова.");
        process.stdout.write(`public key:\n${identity.publicKey}\nfingerprint: ${fingerprint(identity.publicKey)}\n`);
        return 0;
    }
    if (subcommand === "trust") {
        if (!argument)
            throw new PilotError("Укажите публичный ключ или файл", { exitCode: 2 });
        const key = existsSync(argument) ? readFileSync(argument, "utf8") : argument;
        const peers = trustPeer(ctx.cwd, key);
        log.success(`Доверенных узлов: ${String(peers.length)}.`);
        return 0;
    }
    if (subcommand === "status") {
        const identity = readIdentity(ctx.cwd);
        const peers = readPeers(ctx.cwd);
        if (ctx.flags.json) {
            writeOutput(JSON.stringify({ identity: identity ? { fingerprint: fingerprint(identity.publicKey), publicKey: identity.publicKey, createdAt: identity.createdAt } : null, peers }, null, 2), ctx.flags.output);
            return 0;
        }
        if (!identity) {
            log.warn("Identity не создана: oc-pilot hivemind init.");
            return 0;
        }
        process.stdout.write(`fingerprint: ${fingerprint(identity.publicKey)}\npeers: ${String(peers.length)}\n`);
        return 0;
    }
    if (subcommand === "serve") {
        const portRaw = asString(values, "port");
        const port = portRaw ? Number(portRaw) : 41_337;
        const server = await startServer(ctx.cwd, {
            port,
            host: asString(values, "host") ?? "127.0.0.1",
            onMessage: (payload) => log.detail(`hivemind: ${payload.type} от узла`),
        });
        log.success(`Hivemind слушает ${String(server.port)}.`);
        await new Promise((resolveStop) => {
            process.once("SIGINT", () => {
                void server.close().then(() => resolveStop());
            });
        });
        return 0;
    }
    if (subcommand === "send") {
        const portRaw = asString(values, "port");
        const port = portRaw ? Number(portRaw) : 41_337;
        const raw = asString(values, "payload");
        if (!raw)
            throw new PilotError("Укажите --payload <text|@file>", { exitCode: 2 });
        const body = raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw;
        const payload = { type: asString(values, "type") ?? "diff", body };
        const check = validatePayload(payload);
        if (!check.ok)
            throw new PilotError(check.error ?? "Недопустимый payload", { exitCode: 2 });
        const result = await sendMessage(ctx.cwd, {
            host: asString(values, "host") ?? "127.0.0.1",
            port,
            payload,
        });
        if (ctx.flags.json)
            writeOutput(JSON.stringify(result, null, 2), ctx.flags.output);
        else
            process.stdout.write(`${result.ok ? "ok" : "error"}: ${result.response?.type ?? result.error ?? "unknown"}\n`);
        return result.ok ? 0 : 1;
    }
    throw new PilotError("Неизвестная подкоманда hivemind", {
        hint: "Доступно: init, trust, status, serve, send.",
        exitCode: 2,
    });
}
//# sourceMappingURL=hivemind.js.map