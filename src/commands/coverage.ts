import { changedCoverage, changedLines, coverageGaps, loadCoverage, type CoverageSummary } from "../core/coverage.js";
import { loadDiff } from "../core/diff-source.js";
import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean, asString, parsePositiveInt } from "../core/parse.js";

const OPTIONS: OptionSpec = withCommon({
  "coverage-file": { type: "string" },
  diff: { type: "string" },
  staged: { type: "boolean" },
  unstaged: { type: "boolean" },
  base: { type: "string" },
  "include-untracked": { type: "boolean" },
  "fail-under": { type: "string" },
  "max-uncovered": { type: "string" },
});

const HELP = `Использование:
  oc-pilot coverage [пути] [опции]

Сверяет покрытие изменённых строк с отчётом тестов. Понимает lcov,
Istanbul coverage-final.json, Cobertura XML и Go coverprofile. Команда не
вызывает модель и не ходит в сеть; нужен только готовый отчёт покрытия.

Опции:
      --coverage-file <path>  отчёт покрытия (иначе автопоиск)
      --fail-under <n>        код 1, если покрыто меньше n% изменённых строк
      --max-uncovered <n>     код 1, если непокрытых изменённых строк больше n
      --diff <file>           готовый unified diff вместо git-состояния
      --staged                взять staged-изменения
      --unstaged              взять unstaged-изменения
      --base <ref>            дифф <ref>...HEAD
      --include-untracked     включить неотслеживаемые файлы
${COMMON_HELP}

Примеры:
  oc-pilot coverage --staged --coverage-file coverage/lcov.info
  oc-pilot coverage --base main --fail-under 80
  oc-pilot coverage --max-uncovered 0 --json`;

function renderCoverage(
  summary: CoverageSummary,
  counts: { executable: number; covered: number; uncovered: number; percent: number | null },
  changedFiles: string[],
  gate: { failUnder?: number; maxUncovered?: number; passed: boolean },
): string {
  const lines = [
    `Отчёт: ${summary.report.path} (${summary.report.format}).`,
    `Изменённых файлов: ${String(changedFiles.length)}.`,
  ];
  if (counts.executable === 0) {
    lines.push("Исполняемых изменённых строк нет — проверять нечего.");
  } else {
    lines.push(
      `Покрытие изменённых строк: ${String(counts.covered)}/${String(counts.executable)} (${String(counts.percent)}%).`,
    );
    lines.push(`Непокрытых строк: ${String(counts.uncovered)}.`);
  }
  if (summary.missing.length > 0) {
    lines.push(`Нет данных покрытия: ${summary.missing.join(", ")}.`);
  }
  if (summary.gaps.length > 0) {
    lines.push("", "Непокрытые строки:");
    for (const gap of summary.gaps) lines.push(`  ${gap.file}: ${gap.uncovered.join(", ")}`);
  }
  if (gate.failUnder !== undefined || gate.maxUncovered !== undefined) {
    const threshold =
      gate.failUnder !== undefined
        ? `покрытие не ниже ${String(gate.failUnder)}%`
        : `непокрытых строк не больше ${String(gate.maxUncovered)}`;
    lines.push("", `Гейт: ${gate.passed ? "pass" : "fail"} (${threshold}).`);
  }
  return `${lines.join("\n")}\n`;
}

function parseNonNegativeInt(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new PilotError(`Некорректное значение --${flag}: ${raw}`, { exitCode: 2 });
  }
  return value;
}

export async function runCoverage(argv: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const failRaw = asString(values, "fail-under");
  const maxRaw = asString(values, "max-uncovered");
  if (failRaw !== undefined && maxRaw !== undefined) {
    throw new PilotError("--fail-under и --max-uncovered нельзя использовать одновременно", { exitCode: 2 });
  }
  const failUnder = failRaw !== undefined ? parsePositiveInt(failRaw, "fail-under", 100) : undefined;
  const maxUncovered = maxRaw !== undefined ? parseNonNegativeInt(maxRaw, "max-uncovered") : undefined;

  const ctx = resolveContext(values);
  const data = await loadDiff(values, ctx, positionals);
  if (!data.diff.trim()) {
    log.info("Изменений нет — проверять покрытие нечего.");
    return 0;
  }

  const report = loadCoverage(ctx.cwd, asString(values, "coverage-file"));
  if (!report) {
    throw new PilotError("Отчёт покрытия не найден", {
      hint: "Укажите --coverage-file coverage/lcov.info или сгенерируйте отчёт тестами.",
      exitCode: 2,
    });
  }

  const changed = changedLines(data.diff);
  const summary = coverageGaps(report, changed);
  const counts = changedCoverage(report, changed);
  const changedFiles = [...changed.keys()].sort();
  const belowPercent =
    failUnder !== undefined && counts.percent !== null && counts.percent < failUnder;
  const aboveUncovered = maxUncovered !== undefined && summary.uncoveredLines > maxUncovered;
  const gate = { failUnder, maxUncovered, passed: !belowPercent && !aboveUncovered };

  if (ctx.flags.json) {
    const payload = {
      report: { path: report.path, format: report.format },
      changedFiles,
      executableLines: counts.executable,
      coveredLines: counts.covered,
      uncoveredLines: summary.uncoveredLines,
      coveragePercent: counts.percent,
      gaps: summary.gaps,
      missing: summary.missing,
      gate,
    };
    const wrote = writeOutput(JSON.stringify(payload, null, 2), ctx.flags.output);
    if (wrote) log.success(`Отчёт сохранён: ${wrote}`);
    if (!gate.passed) log.error("Покрытие изменённых строк ниже порога.");
    return gate.passed ? 0 : 1;
  }

  const wrote = writeOutput(renderCoverage(summary, counts, changedFiles, gate), ctx.flags.output);
  if (wrote) log.success(`Отчёт сохранён: ${wrote}`);
  if (counts.uncovered > 0) {
    log.warn(`Непокрытых изменённых строк: ${String(counts.uncovered)}.`);
  }
  if (!gate.passed) log.error("Покрытие изменённых строк ниже порога.");
  return gate.passed ? 0 : 1;
}
