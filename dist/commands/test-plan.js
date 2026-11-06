import { loadDiff } from "../core/diff-source.js";
import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString, parsePositiveInt } from "../core/parse.js";
import { describeTestPlan, selectTests } from "../core/test-plan.js";
const OPTIONS = withCommon({
    diff: { type: "string" },
    staged: { type: "boolean" },
    unstaged: { type: "boolean" },
    base: { type: "string" },
    "include-untracked": { type: "boolean" },
    strategy: { type: "string" },
    "max-tests": { type: "string" },
    "fail-on-uncovered": { type: "boolean" },
    "print-command": { type: "boolean" },
    command: { type: "string" },
    "coverage-file": { type: "string" },
});
const HELP = `Использование:
  oc-pilot test-plan [пути] [опции]

Строит граф импортов репозитория и выбирает тестовые файлы, которые
могут быть затронуты изменением. Это детерминированный отбор, а не
предсказание: учитываются прямые и транзитивные импорты, совпадения имён,
ссылки на изменённые символы и необязательный отчёт покрытия.
Модель не вызывается, сеть не используется.

Опции:
      --strategy <s>        affected (по умолчанию), fast или full
      --max-tests <n>       ограничить число выбранных тестов
      --fail-on-uncovered   код 1, если изменённый код не покрыт тестами
      --print-command       подставить выбранные файлы в команду с {files}
      --command <cmd>       тестовая команда для --print-command
      --coverage-file <p>   отчёт lcov/Istanbul/Cobertura/Go для приоритета
      --diff <file>         готовый unified diff вместо git-состояния
      --staged              взять staged-изменения
      --unstaged            взять unstaged-изменения
      --base <ref>          дифф <ref>...HEAD
      --include-untracked   включить неотслеживаемые файлы
${COMMON_HELP}

Примеры:
  oc-pilot test-plan --staged
  oc-pilot test-plan --base origin/main --json
  oc-pilot test-plan --staged --strategy fast
  oc-pilot test-plan --staged --coverage-file coverage/lcov.info
  oc-pilot test-plan --staged --fail-on-uncovered
  oc-pilot test-plan --staged --print-command --command "node --test {files}"`;
function parseStrategy(raw) {
    if (raw === undefined)
        return "affected";
    if (raw === "affected" || raw === "fast" || raw === "full")
        return raw;
    throw new PilotError(`Неизвестная стратегия: ${raw}`, {
        hint: "Допустимые значения: affected, fast, full.",
        exitCode: 2,
    });
}
function renderTestPlan(source, report, failOnUncovered) {
    const lines = [
        `Источник: ${source}`,
        `Стратегия: ${report.strategy}. Файлов просмотрено: ${String(report.stats.scannedFiles)}, связей: ${String(report.stats.graphEdges)}.`,
        `Изменённых файлов: ${String(report.changedFiles.length)}.`,
        "",
        describeTestPlan(report),
    ];
    if (failOnUncovered && report.uncovered.length > 0) {
        lines.push("", "Гейт: fail — есть изменённые файлы без тестов.");
    }
    return `${lines.join("\n")}\n`;
}
export async function runTestPlan(argv) {
    const { values, positionals } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(HELP);
        return 0;
    }
    const strategy = parseStrategy(asString(values, "strategy"));
    const maxRaw = asString(values, "max-tests");
    const maxTests = maxRaw ? parsePositiveInt(maxRaw, "max-tests", 5000) : undefined;
    const failOnUncovered = asBoolean(values, "fail-on-uncovered");
    const printCommand = asBoolean(values, "print-command");
    const command = asString(values, "command");
    const coverageFile = asString(values, "coverage-file");
    if (printCommand && !command) {
        throw new PilotError("--print-command требует --command", {
            hint: 'Пример: --command "node --test {files}".',
            exitCode: 2,
        });
    }
    const ctx = resolveContext(values);
    const data = await loadDiff(values, ctx, positionals, { optionalGit: true });
    if (!data.diff.trim()) {
        log.info("Изменений нет — выбирать тесты нечего.");
        return 0;
    }
    const report = selectTests(ctx.cwd, data.diff, data.changedFiles, {
        strategy,
        maxTests,
        coverageFile,
        printCommand,
        command,
    });
    const failed = failOnUncovered && report.uncovered.length > 0;
    if (ctx.flags.json) {
        const payload = {
            source: data.source,
            ...report,
            gate: { failOnUncovered, passed: !failed },
        };
        const wrote = writeOutput(JSON.stringify(payload, null, 2), ctx.flags.output);
        if (wrote)
            log.success(`Отчёт сохранён: ${wrote}`);
        if (failed)
            log.error(`Без тестов остались файлы: ${report.uncovered.join(", ")}.`);
        return failed ? 1 : 0;
    }
    const wrote = writeOutput(renderTestPlan(data.source, report, failOnUncovered), ctx.flags.output);
    if (wrote)
        log.success(`Отчёт сохранён: ${wrote}`);
    if (report.stats.truncated) {
        log.warn(`План усечён до ${String(report.tests.length)} тестов из ${String(report.stats.totalSelected)}.`);
    }
    if (report.uncovered.length > 0) {
        log.warn(`Изменённые файлы без тестов: ${report.uncovered.join(", ")}.`);
    }
    if (failed)
        log.error("Гейт не пройден: добавьте тесты или уберите --fail-on-uncovered.");
    return failed ? 1 : 0;
}
//# sourceMappingURL=test-plan.js.map