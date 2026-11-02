import { loadDiff } from "../core/diff-source.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean } from "../core/parse.js";
import { formatFindings, severityIcon } from "../core/secrets.js";

const OPTIONS: OptionSpec = withCommon({
  staged: { type: "boolean" },
  unstaged: { type: "boolean" },
  base: { type: "string" },
  diff: { type: "string" },
  stdin: { type: "boolean" },
  "include-untracked": { type: "boolean" },
  "no-fail": { type: "boolean" },
});

const HELP = `Использование:
  oc-pilot scan [пути...] [опции]

Офлайн-поиск секретов в добавленных строках diff. Модель не вызывается.

Опции:
      --staged              только staged-изменения
      --unstaged            только unstaged-изменения
      --base <ref>          diff <ref>...HEAD
      --diff <file|->       готовый diff из файла или stdin
      --stdin               читать diff из stdin
      --include-untracked   включить новые файлы
      --no-fail             всегда exit 0
${COMMON_HELP}

Коды возврата:
  0 — секретов нет
  1 — найдены critical-секреты (или любые при --strict)
  2 — ошибка аргументов

Примеры:
  oc-pilot scan
  oc-pilot scan --staged --strict
  git diff main...HEAD | oc-pilot scan --stdin --json
`;

export async function runScan(argv: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const ctx = resolveContext(values);
  const data = await loadDiff(values, ctx, positionals);

  if (!data.diff.trim()) {
    log.info("Изменений нет — сканировать нечего.");
    return 0;
  }

  const findings = data.findings;
  if (ctx.flags.json) {
    const payload = {
      findings,
      meta: {
        source: data.source,
        filesChanged: data.changedFiles.length,
        stats: data.stats,
        critical: findings.filter((finding) => finding.severity === "critical").length,
        warnings: findings.filter((finding) => finding.severity === "warning").length,
      },
    };
    const path = writeOutput(JSON.stringify(payload, null, 2), ctx.flags.output);
    if (path) log.success(`Результат записан: ${path}`);
  } else if (findings.length === 0) {
    const report = "Секретов не найдено.\n";
    const path = writeOutput(report, ctx.flags.output);
    if (path) log.success(`Результат записан: ${path}`);
    log.success("Секретов не найдено.");
  } else {
    const lines = [
      `Сканирование: ${data.source}`,
      `Файлов в diff: ${data.changedFiles.length}, найдено: ${findings.length}`,
      "",
      ...formatFindings(findings),
      "",
      "Значения в отчёте замаскированы. Рекомендуется отозвать ключи и очистить историю git.",
    ];
    const path = writeOutput(`${lines.join("\n")}\n`, ctx.flags.output);
    if (path) log.success(`Результат записан: ${path}`);
    for (const finding of findings.slice(0, 20)) {
      log.warn(`${severityIcon(finding.severity)} ${finding.file}:${finding.line} — ${finding.kind}`);
    }
    if (findings.length > 20) log.detail(`…и ещё ${findings.length - 20}`);
  }

  if (asBoolean(values, "no-fail")) return 0;
  if (findings.some((finding) => finding.severity === "critical")) return 1;
  if (ctx.flags.strict && findings.length > 0) return 1;
  return 0;
}
