import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean, asString, parsePositiveInt } from "../core/parse.js";
import { assessReadiness, renderBadge, renderReadiness } from "../core/readiness.js";
import {
  applyReadinessFixes,
  planReadinessFixes,
  type ReadinessFix,
  type ReadinessSkip,
} from "../core/readiness-fix.js";

const OPTIONS: OptionSpec = withCommon({
  badge: { type: "boolean" },
  "fail-under": { type: "string" },
  fix: { type: "boolean" },
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
      --dry-run           показать план --fix, ничего не записывая
${COMMON_HELP}

Примеры:
  oc-pilot ready
  oc-pilot ready --badge
  oc-pilot ready --json
  oc-pilot ready --fail-under 85
  oc-pilot ready --fix
  oc-pilot ready --fix --dry-run`;

interface FixInfo {
  applied: boolean;
  dryRun: boolean;
  fixes: ReadinessFix[];
  skipped: ReadinessSkip[];
}

function renderFixLines(info: FixInfo): string {
  if (info.fixes.length === 0 && info.skipped.length === 0) return "";
  const lines: string[] = [];
  for (const fix of info.fixes) {
    lines.push(`${info.dryRun ? "PLAN " : "FIXED"} ${fix.action.padEnd(13)} ${fix.path} — ${fix.reason}`);
  }
  for (const skip of info.skipped) {
    lines.push(`SKIP  ${skip.check.padEnd(13)} ${skip.reason}`);
  }
  if (info.dryRun) lines.push("Режим --dry-run: файлы не изменены.");
  return `${lines.join("\n")}\n`;
}

export async function runReady(argv: string[]): Promise<number> {
  const { values } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const ctx = resolveContext(values);
  let report = assessReadiness(ctx.cwd);

  const fix = asBoolean(values, "fix");
  let fixInfo: FixInfo | undefined;
  if (fix) {
    const plan = planReadinessFixes(ctx.cwd, report);
    const dryRun = ctx.flags.dryRun;
    const applied = dryRun ? [] : applyReadinessFixes(ctx.cwd, plan);
    if (applied.length > 0) report = assessReadiness(ctx.cwd);
    fixInfo = {
      applied: applied.length > 0,
      dryRun,
      fixes: dryRun ? plan.fixes : applied,
      skipped: plan.skipped,
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
  } else {
    const badge = asBoolean(values, "badge") ? `\n${renderBadge(report)}\n` : "";
    const fixBlock = fixInfo ? `\n${renderFixLines(fixInfo)}` : "";
    const wrote = writeOutput(`${renderReadiness(report)}${fixBlock}${badge}`, ctx.flags.output);
    if (wrote) {
      process.stderr.write(`Отчёт сохранён: ${wrote}\n`);
    }
  }

  return failUnder !== undefined && report.score < failUnder ? 1 : 0;
}
