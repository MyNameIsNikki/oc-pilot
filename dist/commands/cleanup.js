import { loadDiff } from "../core/diff-source.js";
import { buildCleanupPlan, applyCleanupPlan, cleanupFailsGate, describeCleanup } from "../core/cleanup.js";
import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";
const OPTIONS = withCommon({
    apply: { type: "boolean" },
    "fail-on-task": { type: "string" },
    diff: { type: "string" },
    staged: { type: "boolean" },
    unstaged: { type: "boolean" },
    base: { type: "string" },
    "include-untracked": { type: "boolean" },
});
const HELP = `Использование:
  oc-pilot cleanup [пути] [опции]

Собирает офлайн-план уборки: проблемы зависимостей, энтропию Slop Index,
переменные окружения и ослабления тестов. Без --apply только показывает план.
С --apply применяет безопасные исправления зависимостей; остальное остаётся
человеку или агенту.

Опции:
      --apply             применить безопасные исправления зависимостей
      --fail-on-task <s>  код 1, если есть задача уровня high|medium|low
      --diff <file>       готовый unified diff
      --staged            взять staged-изменения
      --unstaged          взять unstaged-изменения
      --base <ref>        дифф <ref>...HEAD
      --include-untracked включить неотслеживаемые файлы
${COMMON_HELP}

Примеры:
  oc-pilot cleanup --staged
  oc-pilot cleanup --staged --apply
  oc-pilot cleanup --base main --fail-on-task high
  oc-pilot cleanup --diff changes.diff --json`;
function parseSeverity(raw) {
    if (raw === "high" || raw === "medium" || raw === "low")
        return raw;
    throw new PilotError(`Неизвестный уровень: ${raw}`, {
        hint: "Допустимые значения: high, medium, low.",
        exitCode: 2,
    });
}
function renderCleanup(source, plan, applied) {
    const lines = [
        `Источник: ${source}`,
        `Задач: ${String(plan.counts.total)} (high ${String(plan.counts.high)}, medium ${String(plan.counts.medium)}, low ${String(plan.counts.low)}).`,
    ];
    if (applied)
        lines.push("Безопасные исправления зависимостей применены.");
    lines.push("", describeCleanup(plan));
    return `${lines.join("\n")}\n`;
}
export async function runCleanup(argv) {
    const { values, positionals } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(HELP);
        return 0;
    }
    const failRaw = asString(values, "fail-on-task");
    const failOn = failRaw ? parseSeverity(failRaw) : undefined;
    const ctx = resolveContext(values);
    const data = await loadDiff(values, ctx, positionals);
    if (!data.diff.trim()) {
        log.info("Изменений нет — план уборки пуст.");
        return 0;
    }
    const apply = asBoolean(values, "apply");
    let applied = false;
    let fixed = 0;
    if (apply) {
        const result = applyCleanupPlan(ctx.cwd);
        applied = result.applied;
        fixed = result.fixed;
    }
    const plan = buildCleanupPlan(ctx.cwd, data.diff);
    const failed = failOn !== undefined && cleanupFailsGate(plan.tasks, failOn);
    const payload = {
        source: data.source,
        ...plan,
        applied,
        fixed,
        gate: { failOn, passed: !failed },
    };
    if (ctx.flags.json) {
        const wrote = writeOutput(JSON.stringify(payload, null, 2), ctx.flags.output);
        if (wrote)
            log.success(`Отчёт сохранён: ${wrote}`);
        if (failed)
            log.error(`Есть задачи не ниже ${failOn}.`);
        return failed ? 1 : 0;
    }
    const wrote = writeOutput(renderCleanup(data.source, plan, applied), ctx.flags.output);
    if (wrote)
        log.success(`Отчёт сохранён: ${wrote}`);
    if (plan.counts.total > 0) {
        log.warn(`Задач уборки: ${String(plan.counts.total)}.`);
    }
    else {
        log.success("Задач уборки нет.");
    }
    if (failed)
        log.error(`Есть задачи не ниже ${failOn}.`);
    return failed ? 1 : 0;
}
//# sourceMappingURL=cleanup.js.map