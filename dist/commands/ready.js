import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString, parsePositiveInt } from "../core/parse.js";
import { assessReadiness, renderBadge, renderReadiness } from "../core/readiness.js";
const OPTIONS = withCommon({
    badge: { type: "boolean" },
    "fail-under": { type: "string" },
});
const HELP = `Использование:
  oc-pilot ready [опции]

Оценивает готовность репозитория к работе с ИИ-агентом: тесты, lockfile,
git-хуки, Slop Index, свежая квитанция, инструкции для агентов, CI и конфиг.
Модель не вызывается, сеть не используется.

Опции:
      --badge             напечатать markdown-бейдж для README
      --fail-under <n>    код 1, если оценка ниже n (0-100)
${COMMON_HELP}

Примеры:
  oc-pilot ready
  oc-pilot ready --badge
  oc-pilot ready --json
  oc-pilot ready --fail-under 85`;
export async function runReady(argv) {
    const { values } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(HELP);
        return 0;
    }
    const ctx = resolveContext(values);
    const report = assessReadiness(ctx.cwd);
    const failUnderRaw = asString(values, "fail-under");
    const failUnder = failUnderRaw ? parsePositiveInt(failUnderRaw, "fail-under", 100) : undefined;
    if (failUnder !== undefined && failUnder > 100) {
        throw new PilotError("Порог --fail-under не может быть больше 100", { exitCode: 2 });
    }
    if (ctx.flags.json) {
        writeOutput(`${JSON.stringify(report, null, 2)}\n`, ctx.flags.output);
    }
    else {
        const badge = asBoolean(values, "badge") ? `\n${renderBadge(report)}\n` : "";
        const wrote = writeOutput(`${renderReadiness(report)}${badge}`, ctx.flags.output);
        if (wrote) {
            process.stderr.write(`Отчёт сохранён: ${wrote}\n`);
        }
    }
    return failUnder !== undefined && report.score < failUnder ? 1 : 0;
}
//# sourceMappingURL=ready.js.map