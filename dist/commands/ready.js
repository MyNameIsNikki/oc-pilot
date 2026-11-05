import { runShellCommand } from "../core/command.js";
import { loadDiff } from "../core/diff-source.js";
import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString, parsePositiveInt } from "../core/parse.js";
import { collectPreflight } from "../core/preflight-run.js";
import { detectTestCommand } from "../core/project.js";
import { assessReadiness, renderBadge, renderReadiness } from "../core/readiness.js";
import { applyReadinessFixes, planReadinessFixes, } from "../core/readiness-fix.js";
import { RECEIPT_VERSION, buildReceipt, gitSnapshot, saveReceipt } from "../core/receipt.js";
import { VERSION } from "../version.js";
const OPTIONS = withCommon({
    badge: { type: "boolean" },
    "fail-under": { type: "string" },
    fix: { type: "boolean" },
    receipt: { type: "boolean" },
});
const HELP = `Использование:
  oc-pilot ready [опции]

Оценивает готовность репозитория к работе с ИИ-агентом: тесты, lockfile,
git-хуки, Slop Index, свежая квитанция, инструкции для агентов, CI и конфиг.
Модель не вызывается, сеть не используется.

Опции:
      --badge             напечатать markdown-бейдж для README
      --fail-under <n>    код 1, если оценка ниже n (0-100)
      --fix               создать хук, конфиг и AGENTS.md там, где их нет
      --receipt           с --fix прогнать тесты и preflight, сохранить квитанцию
      --dry-run           показать план --fix, ничего не записывая
${COMMON_HELP}

Примеры:
  oc-pilot ready
  oc-pilot ready --badge
  oc-pilot ready --json
  oc-pilot ready --fail-under 85
  oc-pilot ready --fix
  oc-pilot ready --fix --dry-run
  oc-pilot ready --fix --receipt`;
function renderFixLines(info) {
    if (info.fixes.length === 0 && info.skipped.length === 0 && !info.receipt)
        return "";
    const lines = [];
    for (const fix of info.fixes) {
        lines.push(`${info.dryRun ? "PLAN " : "FIXED"} ${fix.action.padEnd(13)} ${fix.path} — ${fix.reason}`);
    }
    if (info.receipt) {
        lines.push(`RECEIPT ${info.receipt.path} — тесты ${info.receipt.testsPassed ? "пройдены" : "провалены"}, ` +
            `preflight ${info.receipt.preflight === "pass" ? "пройден" : "провален"}`);
    }
    for (const skip of info.skipped) {
        lines.push(`SKIP  ${skip.check.padEnd(13)} ${skip.reason}`);
    }
    if (info.dryRun)
        lines.push("Режим --dry-run: файлы не изменены.");
    return `${lines.join("\n")}\n`;
}
export async function runReady(argv) {
    const { values } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(HELP);
        return 0;
    }
    const ctx = resolveContext(values);
    const fix = asBoolean(values, "fix");
    const wantReceipt = asBoolean(values, "receipt");
    if (wantReceipt && !fix) {
        throw new PilotError("--receipt используется вместе с --fix", {
            hint: "Добавьте --fix, чтобы ready создал квитанцию после исправлений.",
            exitCode: 2,
        });
    }
    let report = assessReadiness(ctx.cwd);
    let fixInfo;
    if (fix) {
        const plan = planReadinessFixes(ctx.cwd, report);
        const dryRun = ctx.flags.dryRun;
        const applied = dryRun ? [] : applyReadinessFixes(ctx.cwd, plan);
        const skipped = plan.skipped.filter((skip) => !(wantReceipt && skip.check === "receipt"));
        let receiptInfo;
        if (wantReceipt && !dryRun) {
            const testCommand = ctx.config.testCommand ?? detectTestCommand(ctx.cwd)?.command;
            if (!testCommand) {
                skipped.push({ check: "receipt", reason: "нет тестовой команды" });
                log.warn("Команда тестов не найдена — квитанция не создана.");
            }
            else {
                const data = await loadDiff(values, ctx, [], { optionalGit: true });
                const test = await runShellCommand(testCommand, ctx.cwd, {
                    timeoutMs: ctx.config.timeoutSeconds * 1000,
                    verbose: ctx.flags.verbose,
                    maxBufferChars: Math.max(200_000, ctx.config.maxOutputChars * 5),
                });
                const preflight = collectPreflight(ctx.cwd, data);
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
                    tests: {
                        command: testCommand,
                        exitCode: test.exitCode,
                        timedOut: test.timedOut,
                        durationMs: test.durationMs,
                        passed: test.exitCode === 0,
                        outputTail: test.output.slice(-2_000),
                    },
                    preflight,
                });
                const path = saveReceipt(ctx.cwd, receipt);
                receiptInfo = { path, testsPassed: test.exitCode === 0, preflight: preflight.status };
            }
        }
        if (applied.length > 0 || receiptInfo)
            report = assessReadiness(ctx.cwd);
        fixInfo = {
            applied: applied.length > 0,
            dryRun,
            fixes: dryRun ? plan.fixes : applied,
            skipped,
            receipt: receiptInfo,
        };
    }
    const failUnderRaw = asString(values, "fail-under");
    const failUnder = failUnderRaw ? parsePositiveInt(failUnderRaw, "fail-under", 100) : undefined;
    if (failUnder !== undefined && failUnder > 100) {
        throw new PilotError("Порог --fail-under не может быть больше 100", { exitCode: 2 });
    }
    if (ctx.flags.json) {
        const payload = fixInfo ? { ...report, fix: fixInfo } : report;
        writeOutput(`${JSON.stringify(payload, null, 2)}\n`, ctx.flags.output);
    }
    else {
        const badge = asBoolean(values, "badge") ? `\n${renderBadge(report)}\n` : "";
        const fixBlock = fixInfo ? `\n${renderFixLines(fixInfo)}` : "";
        const wrote = writeOutput(`${renderReadiness(report)}${fixBlock}${badge}`, ctx.flags.output);
        if (wrote) {
            process.stderr.write(`Отчёт сохранён: ${wrote}\n`);
        }
    }
    return failUnder !== undefined && report.score < failUnder ? 1 : 0;
}
//# sourceMappingURL=ready.js.map