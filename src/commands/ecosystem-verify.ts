import { loadDiff } from "../core/diff-source.js";
import {
  describeEcosystemIssues,
  ecosystemIssueFailsGate,
  verifyEcosystem,
  type EcosystemSeverity,
} from "../core/ecosystem-verify.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean, asString, parsePositiveInt } from "../core/parse.js";

const OPTIONS: OptionSpec = withCommon({
  diff: { type: "string" },
  staged: { type: "boolean" },
  unstaged: { type: "boolean" },
  base: { type: "string" },
  "include-untracked": { type: "boolean" },
  online: { type: "boolean" },
  "min-age-days": { type: "string" },
  "min-downloads": { type: "string" },
  "fail-on-issue": { type: "string" },
});

const HELP = `Использование:
  oc-pilot ecosystem-verify [пути] [опции]

Проверяет, что именованные импорты из изменённых файлов действительно
существуют в установленных пакетах (entry или .d.ts), и что новые пакеты
в package.json не появились вчера с парой загрузок. Офлайн по умолчанию:
сеть нужна только с --online.

Опции:
      --online                проверить возраст и загрузки новых пакетов в npm
      --min-age-days <n>      минимальный возраст пакета (по умолчанию 30)
      --min-downloads <n>     минимум загрузок за неделю (по умолчанию 1000)
      --fail-on-issue <lvl>   код 1 при находке уровня high, medium или low
      --diff <file>           готовый unified diff вместо git-состояния
      --staged                взять staged-изменения
      --unstaged              взять unstaged-изменения
      --base <ref>            дифф <ref>...HEAD
      --include-untracked     включить неотслеживаемые файлы
${COMMON_HELP}

Примеры:
  oc-pilot ecosystem-verify --staged
  oc-pilot ecosystem-verify --base main --online --fail-on-issue high
  oc-pilot ecosystem-verify --diff changes.diff --json`;

const SEVERITIES = new Set<EcosystemSeverity>(["high", "medium", "low"]);

function renderEcosystem(
  source: string,
  report: Awaited<ReturnType<typeof verifyEcosystem>>,
  online: boolean,
  gate: { failOn?: EcosystemSeverity; passed: boolean },
): string {
  const lines = [
    `Источник: ${source}`,
    `Пакетов проверено: ${String(report.packages.length)}, онлайн-проверка: ${online ? "да" : "нет"}.`,
  ];
  if (report.packages.length > 0) {
    lines.push("Пакеты:");
    for (const pkg of report.packages) {
      const state = pkg.installed ? "установлен" : "не установлен";
      const missing = pkg.missingExports.length > 0 ? `, нет экспортов: ${pkg.missingExports.join(", ")}` : "";
      lines.push(`  ${pkg.name} — ${state}, импортов ${String(pkg.imports)}${missing}`);
    }
  }
  if (report.issues.length > 0) {
    lines.push("", "Проблемы:", describeEcosystemIssues(report.issues));
  } else {
    lines.push("Проблем экосистемы не найдено.");
  }
  if (gate.failOn) {
    lines.push(`Гейт: ${gate.passed ? "pass" : "fail"} (${gate.failOn}).`);
  }
  return `${lines.join("\n")}\n`;
}

export async function runEcosystemVerify(argv: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const ctx = resolveContext(values);
  const data = await loadDiff(values, ctx, positionals);
  if (!data.diff.trim()) {
    log.info("Изменений нет — проверять экосистему нечего.");
    return 0;
  }

  const online = asBoolean(values, "online");
  const ageRaw = asString(values, "min-age-days");
  const downloadsRaw = asString(values, "min-downloads");
  const failRaw = asString(values, "fail-on-issue");
  const failOn = failRaw && SEVERITIES.has(failRaw as EcosystemSeverity) ? (failRaw as EcosystemSeverity) : undefined;
  if (failRaw && !failOn) {
    log.warn(`Неизвестный уровень --fail-on-issue: ${failRaw}. Используйте high, medium или low.`);
  }

  const report = await verifyEcosystem(ctx.cwd, data.diff, data.changedFiles, {
    online,
    minAgeDays: ageRaw ? parsePositiveInt(ageRaw, "min-age-days", 3650) : undefined,
    minDownloads: downloadsRaw ? parsePositiveInt(downloadsRaw, "min-downloads", 1_000_000_000) : undefined,
  });
  const passed = !failOn || !ecosystemIssueFailsGate(report.issues, failOn);
  const gate = { failOn, passed };

  if (ctx.flags.json) {
    const payload = { source: data.source, online, ...report, gate };
    const wrote = writeOutput(JSON.stringify(payload, null, 2), ctx.flags.output);
    if (wrote) log.success(`Отчёт сохранён: ${wrote}`);
    if (!passed) log.error(`Найдены проблемы экосистемы уровня ${failOn}.`);
    return passed ? 0 : 1;
  }

  const wrote = writeOutput(renderEcosystem(data.source, report, online, gate), ctx.flags.output);
  if (wrote) log.success(`Отчёт сохранён: ${wrote}`);
  if (report.issues.length > 0) {
    log.warn(`Проблем экосистемы: ${String(report.counts.total)} (high ${String(report.counts.high)}).`);
  }
  if (!passed) log.error(`Найдены проблемы экосистемы уровня ${failOn}.`);
  return passed ? 0 : 1;
}
