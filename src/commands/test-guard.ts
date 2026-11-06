import { loadDiff } from "../core/diff-source.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean } from "../core/parse.js";
import { analyzeTestWeakness, describeTestWeakening, type TestWeakness } from "../core/test-weakening.js";

const OPTIONS: OptionSpec = withCommon({
  diff: { type: "string" },
  staged: { type: "boolean" },
  unstaged: { type: "boolean" },
  base: { type: "string" },
  "include-untracked": { type: "boolean" },
  "fail-on-weakening": { type: "boolean" },
});

const HELP = `Использование:
  oc-pilot test-guard [пути] [опции]

Ищет ослабление тестов в изменённых тестовых файлах: пропущенные и
сфокусированные тесты, удалённые проверки, закомментированные assert,
поднятые таймауты, замену строгих матчеров на проверку существования,
@ts-ignore, пустой catch вокруг проверки и удалённые тесты без замены.
Модель не вызывается и сеть не используется.

Опции:
      --fail-on-weakening  код 1, если найдено хотя бы одно ослабление
      --diff <file>        готовый unified diff вместо git-состояния
      --staged             проверить staged-изменения
      --unstaged           проверить unstaged-изменения
      --base <ref>         diff <ref>...HEAD
      --include-untracked  включить неотслеживаемые файлы
${COMMON_HELP}

Примеры:
  oc-pilot test-guard --staged
  oc-pilot test-guard --base main --fail-on-weakening
  oc-pilot test-guard --diff changes.diff --json`;

function countByKind(findings: TestWeakness[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const finding of findings) {
    counts[finding.kind] = (counts[finding.kind] ?? 0) + 1;
  }
  return counts;
}

function renderGuard(source: string, findings: TestWeakness[]): string {
  const lines = [`Источник: ${source}`, `Найдено ослаблений: ${String(findings.length)}.`];
  if (findings.length === 0) {
    lines.push("Ослабления тестов не найдены.");
  } else {
    lines.push(describeTestWeakening(findings));
  }
  return `${lines.join("\n")}\n`;
}

export async function runTestGuard(argv: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const ctx = resolveContext(values);
  const data = await loadDiff(values, ctx, positionals);
  const findings = analyzeTestWeakness(data.diff);
  const failed = asBoolean(values, "fail-on-weakening") && findings.length > 0;
  const status = failed ? "fail" : findings.length > 0 ? "warn" : "pass";

  if (ctx.flags.json) {
    const payload = {
      source: data.source,
      findings,
      counts: { total: findings.length, byKind: countByKind(findings) },
      status,
    };
    const wrote = writeOutput(JSON.stringify(payload, null, 2), ctx.flags.output);
    if (wrote) log.success(`Отчёт сохранён: ${wrote}`);
    if (failed) log.error(`Найдено ослаблений тестов: ${String(findings.length)}.`);
    return failed ? 1 : 0;
  }

  const wrote = writeOutput(renderGuard(data.source, findings), ctx.flags.output);
  if (wrote) log.success(`Отчёт сохранён: ${wrote}`);
  if (findings.length > 0) {
    log.warn(`Ослабления тестов: ${String(findings.length)}. Агент не должен обходить проверки.`);
  }
  if (failed) log.error(`Найдено ослаблений тестов: ${String(findings.length)}.`);
  return failed ? 1 : 0;
}
