import { describeDiffSource, loadDiff } from "../core/diff-source.js";
import { PilotError } from "../core/errors.js";
import { checkInvariants } from "../core/invariants.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";
import { renderPreflight } from "../core/preflight.js";
import { collectPreflight } from "../core/preflight-run.js";
const OPTIONS = withCommon({
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
    "no-honeypot": { type: "boolean" },
    "no-injection": { type: "boolean" },
    invariants: { type: "boolean" },
    "fail-on-invariants": { type: "boolean" },
});
const HELP = `Использование:
  oc-pilot preflight [пути] [опции]

Офлайн-проверка изменения перед коммитом: секреты, SAST, авторизация
маршрутов, здоровье зависимостей, ослабление тестов, дельта Slop Index
и срабатывание honeypot.
Модель не вызывается, сеть не используется. Один вердикт и один код
возврата для CI.

Опции:
      --base <ref>          сравнить с ref (git diff ref...HEAD)
      --staged              проверить staged-изменения
      --unstaged            проверить unstaged-изменения
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
      --no-honeypot         не проверять приманки honeypot
      --no-injection        не проверять prompt-injection в тексте для агента
      --invariants          дополнительно проверить .oc-pilot/invariants.md моделью
      --fail-on-invariants  считать любое нарушение инвариантов блокирующим
${COMMON_HELP}

Примеры:
  oc-pilot preflight
  oc-pilot preflight --base main --max-delta 0
  oc-pilot preflight --staged --json
  oc-pilot preflight --no-slop --fail-on-issue medium`;
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
export async function runPreflight(argv) {
    const { values, positionals } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(HELP);
        return 0;
    }
    const ctx = resolveContext(values);
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
    if (asBoolean(values, "no-honeypot"))
        disabled.push("honeypot");
    if (asBoolean(values, "no-injection"))
        disabled.push("injection");
    const data = await loadDiff(values, ctx, positionals, { optionalGit: true });
    const gate = parseGate(asString(values, "fail-on-issue"));
    const report = collectPreflight(ctx.cwd, data, {
        disabled,
        depsGate: gate,
        sastGate: gate,
        authzGate: gate === "high" ? "high" : "medium",
        maxSlopDelta: optionalNumber(values, "max-delta"),
        since: asString(values, "since"),
    });
    const invariants = asBoolean(values, "invariants")
        ? await checkInvariants(ctx.cwd, ctx, {
            diff: data.diff,
            payloadDiff: data.payloadDiff,
            changedFiles: data.changedFiles,
            findings: data.findings,
            source: describeDiffSource(data.source),
        }, { strict: asBoolean(values, "fail-on-invariants") })
        : undefined;
    const payload = invariants ? { ...report, invariants } : report;
    const text = ctx.flags.json
        ? `${JSON.stringify(payload, null, 2)}\n`
        : `${renderPreflight(report)}${invariants ? `\n${invariants.content}` : ""}`;
    const wrote = writeOutput(text, ctx.flags.output);
    if (wrote)
        log.success(`Отчёт сохранён: ${wrote}`);
    if (report.status === "fail")
        return 1;
    if (invariants?.exitCode === 3)
        return 3;
    return 0;
}
//# sourceMappingURL=preflight.js.map