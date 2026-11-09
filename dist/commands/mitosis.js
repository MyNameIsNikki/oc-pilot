import { loadDiff, describeDiffSource } from "../core/diff-source.js";
import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { applyMitosis, buildMitosisPlan, renderMitosisPlan, renderMitosisPlanMarkdown, } from "../core/mitosis.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString, parsePositiveInt, parseSeconds } from "../core/parse.js";
const OPTIONS = withCommon({
    strategy: { type: "string" },
    "max-files": { type: "string" },
    prefix: { type: "string" },
    branch: { type: "string" },
    "test-command": { type: "string" },
    "test-timeout": { type: "string" },
    "no-test": { type: "boolean" },
    confirm: { type: "boolean" },
    force: { type: "boolean" },
    markdown: { type: "boolean" },
    diff: { type: "string" },
    stdin: { type: "boolean" },
    staged: { type: "boolean" },
    unstaged: { type: "boolean" },
    base: { type: "string" },
    "include-untracked": { type: "boolean" },
});
const HELP = `Использование:
  oc-pilot mitosis plan [опции]
  oc-pilot mitosis apply --confirm [опции]

Разбивает большой diff на последовательность маленьких коммитов по файлам,
каталогам или типам. plan только показывает план. apply создаёт коммиты в
shadow worktree, по желанию прогоняет тесты после каждого и оставляет ветку
в реальном репозитории плюс патчи в .oc-pilot/mitosis.

Статусы apply:
  [MITOSIS APPLIED]  все коммиты созданы, тесты прошли или пропущены
  [MITOSIS FAILED]   тесты упали на одном из коммитов

Опции:
      --strategy <s>        file, dir (по умолчанию) или type
      --max-files <20>      максимум файлов в одном коммите
      --prefix <text>       префикс сообщения коммита (по умолчанию mitosis)
      --branch <name>       имя ветки для apply
      --test-command <cmd>  команда тестов после каждого коммита
      --test-timeout <300s> таймаут одного прогона тестов
      --no-test             не запускать тесты
      --confirm             подтвердить создание коммитов и ветки
      --force               перезаписать существующую ветку
      --markdown            план в Markdown
      --diff <file|->       готовый unified diff
      --stdin               читать diff из stdin
      --staged              только staged-изменения
      --unstaged            только unstaged-изменения
      --base <ref>          diff против ветки
      --include-untracked   добавить неотслеживаемые файлы
${COMMON_HELP}

Коды выхода apply:
  0  все коммиты созданы и тесты прошли
  1  тесты упали на одном из коммитов
  2  ошибка diff, патча или git

Примеры:
  oc-pilot mitosis plan --strategy type
  oc-pilot mitosis plan --staged --markdown
  oc-pilot mitosis apply --staged --confirm --branch oc-pilot/split
  oc-pilot mitosis apply --base main --confirm --test-command "npm test"`;
function parseStrategy(raw) {
    if (raw === undefined || raw.trim() === "")
        return "dir";
    const value = raw.trim();
    if (value === "file" || value === "dir" || value === "type")
        return value;
    throw new PilotError(`Неизвестная стратегия mitosis: ${raw}`, {
        hint: "Используйте file, dir или type.",
        exitCode: 2,
    });
}
export async function runMitosis(argv) {
    const { values, positionals } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(`${HELP}\n`);
        return 0;
    }
    const [subcommand] = positionals;
    const ctx = resolveContext(values);
    if (subcommand !== "plan" && subcommand !== "apply") {
        throw new PilotError("Неизвестная подкоманда mitosis", {
            hint: "Доступно: plan, apply.",
            exitCode: 2,
        });
    }
    const data = await loadDiff(values, ctx, [], { optionalGit: true });
    if (!data.diff.trim()) {
        log.info("Изменений нет — делить нечего.");
        return 0;
    }
    const maxFilesRaw = asString(values, "max-files");
    const timeoutRaw = asString(values, "test-timeout");
    const strategy = parseStrategy(asString(values, "strategy"));
    const options = {
        strategy,
        maxFiles: maxFilesRaw ? parsePositiveInt(maxFilesRaw, "max-files", 500) : undefined,
        prefix: asString(values, "prefix"),
    };
    if (subcommand === "plan") {
        const plan = buildMitosisPlan(data.diff, options);
        const text = asBoolean(values, "markdown")
            ? renderMitosisPlanMarkdown(plan)
            : renderMitosisPlan(plan);
        const wrote = ctx.flags.json
            ? writeOutput(JSON.stringify({ source: describeDiffSource(data.source), ...plan }, null, 2), ctx.flags.output)
            : writeOutput(text, ctx.flags.output);
        if (wrote)
            log.success(`План сохранён: ${wrote}`);
        return 0;
    }
    if (!asBoolean(values, "confirm")) {
        throw new PilotError("apply создаёт коммиты и ветку; добавьте --confirm", {
            hint: "Сначала посмотрите план: oc-pilot mitosis plan.",
            exitCode: 2,
        });
    }
    const result = await applyMitosis(ctx.cwd, data.diff, {
        ...options,
        branch: asString(values, "branch"),
        testCommand: asString(values, "test-command"),
        runTests: !asBoolean(values, "no-test"),
        timeoutMs: timeoutRaw ? parseSeconds(timeoutRaw, "test-timeout") * 1000 : undefined,
        force: asBoolean(values, "force"),
    });
    const wrote = ctx.flags.json
        ? writeOutput(JSON.stringify(result, null, 2), ctx.flags.output)
        : writeOutput(result.content, ctx.flags.output);
    if (wrote)
        log.success(`Результат сохранён: ${wrote}`);
    if (result.status === "failed") {
        log.error(result.summary);
        return 1;
    }
    log.success(result.summary);
    return 0;
}
//# sourceMappingURL=mitosis.js.map