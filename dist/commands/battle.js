import { PilotError } from "../core/errors.js";
import { loadDiff } from "../core/diff-source.js";
import { runBattle, renderBattle } from "../core/battle.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString, parsePositiveInt } from "../core/parse.js";
const OPTIONS = withCommon({
    apply: { type: "boolean" },
    rounds: { type: "string" },
    command: { type: "string" },
    context: { type: "string" },
    diff: { type: "string" },
    staged: { type: "boolean" },
    unstaged: { type: "boolean" },
    base: { type: "string" },
    "include-untracked": { type: "boolean" },
});
const HELP = `Использование:
  oc-pilot battle "задача" [опции]

Экспериментальный режим двух агентов. Coder просит модель предложить
патч и проверяет его тестами, Hacker атакует патч: ревью, SAST,
авторизация маршрутов и защита тестов. Раунды повторяются, пока не
останется high-находок и тесты не пройдут.

Без --apply патч только показывается и атакуется, дерево не меняется.
С --apply патч применяется, тесты запускаются, а следующие раунды
чинят найденные проблемы. Это дорого: каждый раунд делает несколько
вызовов модели.

Опции:
      --apply             применять патч и запускать тесты
      --rounds <n>        число раундов (по умолчанию 2, максимум 5)
      --command <cmd>     команда тестов (иначе testCommand или автоопределение)
      --context <text>    дополнительный контекст для обоих агентов
      --diff <file>       готовый unified diff вместо git-состояния
      --staged            взять staged-изменения
      --unstaged          взять unstaged-изменения
      --base <ref>        дифф <ref>...HEAD
      --include-untracked включить неотслеживаемые файлы
${COMMON_HELP}

Примеры:
  oc-pilot battle "почини гонку в retry"
  oc-pilot battle "убери утечку токена" --apply --rounds 3
  oc-pilot battle "укрепи авторизацию" --staged --json`;
export async function runBattleCommand(argv) {
    const { values, positionals } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(HELP);
        return 0;
    }
    const task = positionals.join(" ").trim();
    if (!task) {
        throw new PilotError('Укажите задачу: oc-pilot battle "что нужно сделать"', { exitCode: 2 });
    }
    const ctx = resolveContext(values);
    const data = await loadDiff(values, ctx, [], { optionalGit: true });
    if (!data.diff.trim()) {
        log.info("Изменений нет — атаковать нечего.");
        return 0;
    }
    const roundsRaw = asString(values, "rounds");
    const rounds = roundsRaw ? parsePositiveInt(roundsRaw, "rounds", 5) : 2;
    const report = runBattle(ctx.cwd, {
        task,
        apply: asBoolean(values, "apply"),
        rounds,
        command: asString(values, "command") ?? ctx.config.testCommand,
        context: asString(values, "context"),
        diff: data.diff,
        model: ctx.config.model,
    });
    if (ctx.flags.json) {
        const wrote = writeOutput(JSON.stringify({ source: data.source, ...report }, null, 2), ctx.flags.output);
        if (wrote)
            log.success(`Отчёт сохранён: ${wrote}`);
        if (report.status !== "pass")
            log.error(`Battle: ${report.status}. ${report.reason}`);
        return report.status === "pass" ? 0 : 1;
    }
    const wrote = writeOutput(renderBattle(report), ctx.flags.output);
    if (wrote)
        log.success(`Отчёт сохранён: ${wrote}`);
    if (report.status !== "pass")
        log.error(`Battle: ${report.status}. ${report.reason}`);
    return report.status === "pass" ? 0 : 1;
}
//# sourceMappingURL=battle.js.map