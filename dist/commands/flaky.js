import { randomBytes } from "node:crypto";
import { runShellCommand } from "../core/command.js";
import { PilotError } from "../core/errors.js";
import { buildFlakyReport, buildShuffleCommand, renderFlaky } from "../core/flaky.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString, parsePositiveInt } from "../core/parse.js";
import { detectTestCommand } from "../core/project.js";
import { readRepository } from "../core/slop/collect.js";
import { isTestFile } from "../core/slop/source.js";
const OPTIONS = withCommon({
    runs: { type: "string" },
    command: { type: "string" },
    "fail-on-flaky": { type: "boolean" },
    shuffle: { type: "boolean" },
    seed: { type: "string" },
});
const HELP = `Использование:
  oc-pilot flaky [опции]

Запускает тесты несколько раз подряд и сравнивает результаты отдельных тестов.
Тест, который в одних прогонах прошёл, а в других упал, помечается нестабильным.
Команда не вызывает модель и работает только с выводом тестового раннера.

Опции:
      --runs <n>        сколько раз запускать тесты (по умолчанию 3, максимум 10)
      --command <cmd>   команда тестов (иначе testCommand или автоопределение)
      --fail-on-flaky   код 1, если найден хотя бы один нестабильный тест
      --shuffle         перемешать тестовые файлы между прогонами
      --seed <value>    seed для --shuffle (по умолчанию случайный)
${COMMON_HELP}

Примеры:
  oc-pilot flaky
  oc-pilot flaky --runs 5
  oc-pilot flaky --shuffle --command "node --test {files}"
  oc-pilot flaky --command "go test ./..." --json
  oc-pilot flaky --fail-on-flaky`;
export async function runFlaky(argv) {
    const { values } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(HELP);
        return 0;
    }
    const ctx = resolveContext(values);
    const runsRaw = asString(values, "runs");
    const runs = runsRaw ? parsePositiveInt(runsRaw, "runs", 10) : 3;
    const shuffle = asBoolean(values, "shuffle");
    let files = [];
    let seed = "";
    const command = asString(values, "command") ?? ctx.config.testCommand ?? detectTestCommand(ctx.cwd)?.command;
    if (!command) {
        throw new PilotError("Не найдена команда тестов", {
            hint: "Укажите --command или поле testCommand в .oc-pilot.json.",
            exitCode: 2,
        });
    }
    if (shuffle) {
        files = readRepository(ctx.cwd)
            .files.map((file) => file.path)
            .filter(isTestFile)
            .sort();
        if (files.length === 0) {
            throw new PilotError("Не найдено тестовых файлов для --shuffle", {
                hint: "Проверьте, что тесты лежат в репозитории и не игнорируются git.",
                exitCode: 2,
            });
        }
        if (!command.includes("{files}")) {
            throw new PilotError("--shuffle требует {files} в --command", {
                hint: 'Пример: --command "node --test {files}".',
                exitCode: 2,
            });
        }
        seed = asString(values, "seed") ?? randomBytes(4).toString("hex");
    }
    const results = [];
    for (let run = 1; run <= runs; run += 1) {
        const runCommand = shuffle ? buildShuffleCommand(command, files, `${seed}:${String(run)}`) : command;
        log.detail(`Прогон ${String(run)}/${String(runs)}: ${runCommand}`);
        const result = await runShellCommand(runCommand, ctx.cwd, {
            timeoutMs: ctx.config.timeoutSeconds * 1000,
            verbose: ctx.flags.verbose,
            maxBufferChars: Math.max(200_000, ctx.config.maxOutputChars * 5),
        });
        results.push({
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            durationMs: result.durationMs,
            output: result.output,
        });
    }
    const report = buildFlakyReport(command, results);
    if (shuffle)
        report.shuffle = { seed, files: files.length };
    const failed = asBoolean(values, "fail-on-flaky") && report.flaky.length > 0;
    if (ctx.flags.json) {
        writeOutput(JSON.stringify(report, null, 2), ctx.flags.output);
        return failed ? 1 : 0;
    }
    writeOutput(renderFlaky(report), ctx.flags.output);
    if (report.flaky.length > 0) {
        log.warn(`Нестабильных тестов: ${String(report.flaky.length)}.`);
    }
    if (!report.parsed) {
        log.warn("Не удалось распознать отдельные тесты в выводе — показана только стабильность прогонов.");
    }
    return failed ? 1 : 0;
}
//# sourceMappingURL=flaky.js.map