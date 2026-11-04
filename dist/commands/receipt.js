import { runShellCommand } from "../core/command.js";
import { loadDiff } from "../core/diff-source.js";
import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";
import { collectPreflight } from "../core/preflight-run.js";
import { detectTestCommand } from "../core/project.js";
import { RECEIPT_VERSION, buildReceipt, gitSnapshot, readReceipt, receiptPath, renderReceipt, saveReceipt, verifyReceipt, } from "../core/receipt.js";
import { VERSION } from "../version.js";
const OPTIONS = withCommon({
    verify: { type: "boolean" },
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
      --fail-on-issue <lvl> порог зависимостей: high, medium или low (по умолчанию high)
      --no-secret-scan      не проверять секреты
      --no-deps             не проверять зависимости
      --no-tests            не искать ослабление тестов
      --no-slop             не считать дельту Slop Index
${COMMON_HELP}

Примеры:
  oc-pilot receipt
  oc-pilot receipt --json
  oc-pilot receipt --out receipt.json
  oc-pilot receipt --verify
  oc-pilot receipt --verify --receipt receipt.json`;
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
    const receipt = readReceipt(path);
    const verification = verifyReceipt(ctx.cwd, receipt);
    const text = ctx.flags.json
        ? `${JSON.stringify({ path, ...verification }, null, 2)}\n`
        : `${renderReceipt(receipt, path)}Проверка: ${verification.ok ? "действительна" : `недействительна — ${verification.reason}`}.\n`;
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
    if (asBoolean(values, "verify"))
        return runVerify(values, ctx);
    const disabled = [];
    if (asBoolean(values, "no-secret-scan"))
        disabled.push("secrets");
    if (asBoolean(values, "no-deps"))
        disabled.push("deps");
    if (asBoolean(values, "no-tests"))
        disabled.push("tests");
    if (asBoolean(values, "no-slop"))
        disabled.push("slop");
    const data = await loadDiff(values, ctx, positionals, { optionalGit: true });
    const preflight = collectPreflight(ctx.cwd, data, {
        disabled,
        depsGate: parseGate(asString(values, "fail-on-issue")),
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
    const receipt = buildReceipt({
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
    });
    const saved = saveReceipt(ctx.cwd, receipt, asString(values, "out"));
    const text = ctx.flags.json ? `${JSON.stringify(receipt, null, 2)}\n` : renderReceipt(receipt, saved);
    const wrote = writeOutput(text, ctx.flags.output);
    if (wrote)
        log.success(`Отчёт сохранён: ${wrote}`);
    const failed = tests?.passed === false || preflight.status === "fail";
    return failed ? 1 : 0;
}
//# sourceMappingURL=receipt.js.map