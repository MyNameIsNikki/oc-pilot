import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runShellCommand } from "../core/command.js";
import { loadDiff } from "../core/diff-source.js";
import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";
import { collectPreflight } from "../core/preflight-run.js";
import { detectTestCommand } from "../core/project.js";
import { RECEIPT_VERSION, buildReceipt, gitSnapshot, readReceipt, receiptPath, receiptPublicKeyPath, readReceiptPublicKey, renderReceipt, saveReceipt, signReceipt, generateReceiptKeyPair, verifyReceipt, } from "../core/receipt.js";
import { VERSION } from "../version.js";
const OPTIONS = withCommon({
    verify: { type: "boolean" },
    sign: { type: "boolean" },
    key: { type: "string" },
    "public-key": { type: "string" },
    keygen: { type: "string" },
    receipt: { type: "string" },
    out: { type: "string" },
    "no-run": { type: "boolean" },
    command: { type: "string" },
    diff: { type: "string" },
    stdin: { type: "boolean" },
    staged: { type: "boolean" },
    unstaged: { type: "boolean" },
    base: { type: "string" },
    "include-untracked": { type: "boolean" },
    since: { type: "string" },
    "max-delta": { type: "string" },
    "fail-on-issue": { type: "string" },
    "no-secret-scan": { type: "boolean" },
    "no-sast": { type: "boolean" },
    "no-authz": { type: "boolean" },
    "no-deps": { type: "boolean" },
    "no-tests": { type: "boolean" },
    "no-slop": { type: "boolean" },
});
const HELP = `Использование:
  oc-pilot receipt [опции]
  oc-pilot receipt --verify [--receipt <file>]

Прогоняет тесты и офлайн-preflight, затем сохраняет JSON-квитанцию,
привязанную к коммиту. Квитанция хранит SHA коммита, ветку, признак
изменённого дерева, статистику диффа, результат тестов и полный отчёт
preflight, а также SHA-256 всех этих данных. Модель не вызывается.
По умолчанию файл лежит в .git/oc-pilot/receipt.json.

Опции:
      --verify              проверить сохранённую квитанцию вместо создания
      --sign                подписать квитанцию Ed25519-ключом
      --key <file>          приватный ключ для --sign (или OC_PILOT_RECEIPT_KEY)
      --public-key <file>   публичный ключ для --verify (или .oc-pilot/receipt.pub)
      --keygen <file>       создать пару ключей: <file> и <file>.pub
      --receipt <file>      путь к квитанции для --verify
      --out <file>          сохранить копию в указанный файл
      --no-run              не запускать тесты
      --command <cmd>       команда тестов (иначе testCommand или автоопределение)
      --base <ref>          сравнить с ref (git diff ref...HEAD)
      --staged              взять staged-изменения
      --unstaged            взять unstaged-изменения
      --include-untracked   включить неотслеживаемые файлы
      --diff <file>         готовый unified diff вместо git-состояния
      --since <ref>         база для дельты slop (по умолчанию HEAD)
      --max-delta <n>       допустимый рост Slop Index (по умолчанию 10)
      --fail-on-issue <lvl> порог SAST, authz и зависимостей: high, medium или low (по умолчанию high)
      --no-secret-scan      не проверять секреты
      --no-sast             не запускать SAST
      --no-authz            не проверять авторизацию маршрутов
      --no-deps             не проверять зависимости
      --no-tests            не искать ослабление тестов
      --no-slop             не считать дельту Slop Index
${COMMON_HELP}

Примеры:
  oc-pilot receipt
  oc-pilot receipt --json
  oc-pilot receipt --out receipt.json
  oc-pilot receipt --verify
  oc-pilot receipt --verify --receipt receipt.json
  oc-pilot receipt --keygen receipt.key
  oc-pilot receipt --sign --key receipt.key
  oc-pilot receipt --verify --public-key receipt.key.pub`;
function parseGate(raw) {
    if (raw === undefined || raw.trim() === "")
        return "high";
    const value = raw.trim().toLowerCase();
    if (value === "high" || value === "medium" || value === "low")
        return value;
    throw new PilotError(`Некорректный порог --fail-on-issue: ${raw}`, {
        hint: "Допустимые значения: high, medium, low.",
        exitCode: 2,
    });
}
function optionalNumber(values, key) {
    const raw = asString(values, key);
    if (raw === undefined || raw.trim() === "")
        return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
        throw new PilotError(`Некорректное значение --${key}: ${raw}`, {
            hint: "Ожидается число.",
            exitCode: 2,
        });
    }
    return parsed;
}
function runVerify(values, ctx) {
    const explicit = asString(values, "receipt");
    const path = explicit ?? receiptPath(ctx.cwd);
    if (!path) {
        throw new PilotError("Не найдена квитанция для проверки", {
            hint: "Укажите --receipt <file> или запустите команду в git-репозитории.",
            exitCode: 2,
        });
    }
    if (!existsSync(path)) {
        const verification = {
            ok: false,
            hashOk: false,
            stale: false,
            commit: null,
            head: null,
            signature: "missing",
            reason: `квитанция не найдена: ${path}`,
        };
        const text = ctx.flags.json
            ? `${JSON.stringify({ path, ...verification }, null, 2)}\n`
            : `Проверка: недействительна — квитанция не найдена: ${path}.\n`;
        const wrote = writeOutput(text, ctx.flags.output);
        if (wrote)
            log.success(`Отчёт сохранён: ${wrote}`);
        return 1;
    }
    const explicitKey = asString(values, "public-key") ?? process.env.OC_PILOT_RECEIPT_PUBLIC_KEY;
    let publicKey;
    if (explicitKey) {
        try {
            publicKey = readFileSync(resolve(ctx.cwd, explicitKey), "utf8");
        }
        catch {
            throw new PilotError(`Не удалось прочитать публичный ключ: ${explicitKey}`, {
                hint: "Укажите --public-key <file> с Ed25519-ключом в PEM.",
                exitCode: 2,
            });
        }
    }
    else {
        publicKey = readReceiptPublicKey(ctx.cwd);
    }
    const receipt = readReceipt(path);
    const verification = verifyReceipt(ctx.cwd, receipt, publicKey);
    const signatureText = verification.signature === "valid"
        ? "действительна"
        : verification.signature === "invalid"
            ? "недействительна"
            : verification.signature === "unchecked"
                ? "не проверялась"
                : "отсутствует";
    const text = ctx.flags.json
        ? `${JSON.stringify({ path, ...verification }, null, 2)}\n`
        : `${renderReceipt(receipt, path)}Подпись: ${signatureText}.\nПроверка: ${verification.ok ? "действительна" : `недействительна — ${verification.reason}`}.\n`;
    const wrote = writeOutput(text, ctx.flags.output);
    if (wrote)
        log.success(`Отчёт сохранён: ${wrote}`);
    return verification.ok ? 0 : 1;
}
export async function runReceipt(argv) {
    const { values, positionals } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(HELP);
        return 0;
    }
    const ctx = resolveContext(values);
    const keygenPath = asString(values, "keygen");
    if (keygenPath) {
        const target = resolve(ctx.cwd, keygenPath);
        const pair = generateReceiptKeyPair();
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, pair.privateKey, { encoding: "utf8", mode: 0o600 });
        writeFileSync(`${target}.pub`, pair.publicKey, "utf8");
        log.success(`Приватный ключ: ${target}`);
        log.success(`Публичный ключ: ${target}.pub`);
        log.info(`Скопируйте публичный ключ в ${receiptPublicKeyPath(ctx.cwd)}, чтобы ready и CI проверяли подпись.`);
        return 0;
    }
    const sign = asBoolean(values, "sign");
    if (asBoolean(values, "verify")) {
        if (sign) {
            throw new PilotError("--verify не сочетается с --sign", {
                hint: "Подписывайте квитанцию при создании, а проверяйте отдельной командой.",
                exitCode: 2,
            });
        }
        return runVerify(values, ctx);
    }
    const disabled = [];
    if (asBoolean(values, "no-secret-scan"))
        disabled.push("secrets");
    if (asBoolean(values, "no-sast"))
        disabled.push("sast");
    if (asBoolean(values, "no-authz"))
        disabled.push("authz");
    if (asBoolean(values, "no-deps"))
        disabled.push("deps");
    if (asBoolean(values, "no-tests"))
        disabled.push("tests");
    if (asBoolean(values, "no-slop"))
        disabled.push("slop");
    const data = await loadDiff(values, ctx, positionals, { optionalGit: true });
    const gate = parseGate(asString(values, "fail-on-issue"));
    const preflight = collectPreflight(ctx.cwd, data, {
        disabled,
        depsGate: gate,
        sastGate: gate,
        authzGate: gate === "high" ? "high" : "medium",
        maxSlopDelta: optionalNumber(values, "max-delta"),
        since: asString(values, "since"),
    });
    let tests = null;
    if (!asBoolean(values, "no-run")) {
        const testCommand = asString(values, "command") ?? ctx.config.testCommand ?? detectTestCommand(ctx.cwd)?.command;
        if (!testCommand) {
            log.warn("Команда тестов не найдена — квитанция будет без прогона тестов.");
        }
        else {
            const result = await runShellCommand(testCommand, ctx.cwd, {
                timeoutMs: ctx.config.timeoutSeconds * 1000,
                verbose: ctx.flags.verbose,
                maxBufferChars: Math.max(200_000, ctx.config.maxOutputChars * 5),
            });
            tests = {
                command: testCommand,
                exitCode: result.exitCode,
                timedOut: result.timedOut,
                durationMs: result.durationMs,
                passed: result.exitCode === 0,
                outputTail: result.output.slice(-2_000),
            };
        }
    }
    const snapshot = gitSnapshot(ctx.cwd);
    const body = {
        version: RECEIPT_VERSION,
        tool: "oc-pilot",
        toolVersion: VERSION,
        createdAt: new Date().toISOString(),
        commit: snapshot.commit,
        branch: snapshot.branch,
        dirty: snapshot.dirty,
        diff: data.stats,
        files: data.changedFiles,
        tests,
        preflight,
    };
    const signKey = asString(values, "key") ?? process.env.OC_PILOT_RECEIPT_KEY;
    let receipt;
    if (sign) {
        if (!signKey) {
            throw new PilotError("Для --sign нужен приватный ключ", {
                hint: "Укажите --key <file> или переменную OC_PILOT_RECEIPT_KEY. Создайте пару: oc-pilot receipt --keygen <file>.",
                exitCode: 2,
            });
        }
        let privateKey;
        try {
            privateKey = readFileSync(resolve(ctx.cwd, signKey), "utf8");
        }
        catch {
            throw new PilotError(`Не удалось прочитать приватный ключ: ${signKey}`, {
                hint: "Укажите путь к Ed25519-ключу в PEM (PKCS#8).",
                exitCode: 2,
            });
        }
        receipt = signReceipt(body, privateKey);
    }
    else {
        receipt = buildReceipt(body);
    }
    const saved = saveReceipt(ctx.cwd, receipt, asString(values, "out"));
    const text = ctx.flags.json ? `${JSON.stringify(receipt, null, 2)}\n` : renderReceipt(receipt, saved);
    const wrote = writeOutput(text, ctx.flags.output);
    if (wrote)
        log.success(`Отчёт сохранён: ${wrote}`);
    const failed = tests?.passed === false || preflight.status === "fail";
    return failed ? 1 : 0;
}
//# sourceMappingURL=receipt.js.map