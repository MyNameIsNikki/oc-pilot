import { describeDiffSource, loadDiff } from "../core/diff-source.js";
import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { checkWardenPolicy, initWardenPolicy, readWardenPolicy, renderWardenPolicy, WARDEN_POLICY, } from "../core/warden.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean } from "../core/parse.js";
const OPTIONS = withCommon({
    force: { type: "boolean" },
    diff: { type: "string" },
    stdin: { type: "boolean" },
    staged: { type: "boolean" },
    unstaged: { type: "boolean" },
    base: { type: "string" },
    "include-untracked": { type: "boolean" },
});
const HELP = `Использование:
  oc-pilot warden check [опции diff]
  oc-pilot warden init [--force]
  oc-pilot warden show

Проверяет diff против политики .oc-pilot/policy.json: запрещённые пути
и содержимое, зависимости, расширения, обязательные тесты и размер diff.
Всё детерминированно, модель не используется.

Правила (kind):
  forbid-paths      запрещённые пути (glob с * и **)
  forbid-content    запрещённые regex в добавленных строках
  forbid-deps       запрещённые зависимости
  forbid-extensions запрещённые расширения файлов
  require-tests     исходники меняются только вместе с тестами
  max-files         максимум файлов в diff

Опции:
      --force             перезаписать существующую политику при init
      --diff <file|->     готовый unified diff
      --stdin             читать diff из stdin
      --staged            только staged-изменения
      --unstaged          только unstaged-изменения
      --base <ref>        diff против ветки
      --include-untracked добавить неотслеживаемые файлы
${COMMON_HELP}

Коды выхода check:
  0  [POLICY PASS]
  1  [POLICY VIOLATION]
  2  политика не найдена или повреждена

Примеры:
  oc-pilot warden init
  oc-pilot warden check --staged
  oc-pilot warden show --json`;
export async function runWarden(argv) {
    const { values, positionals } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(`${HELP}\n`);
        return 0;
    }
    const [subcommand] = positionals;
    const ctx = resolveContext(values);
    if (subcommand === "init") {
        const result = initWardenPolicy(ctx.cwd, asBoolean(values, "force"));
        if (ctx.flags.json)
            writeOutput(JSON.stringify(result, null, 2), ctx.flags.output);
        else
            process.stdout.write(`Warden: политика записана в ${result.written}.\n`);
        return 0;
    }
    if (subcommand === "show") {
        const policy = readWardenPolicy(ctx.cwd);
        if (!policy) {
            throw new PilotError(`Политика не найдена: ${WARDEN_POLICY}`, {
                hint: "Создайте её: oc-pilot warden init.",
                exitCode: 2,
            });
        }
        const wrote = ctx.flags.json
            ? writeOutput(JSON.stringify(policy, null, 2), ctx.flags.output)
            : writeOutput(renderWardenPolicy(policy), ctx.flags.output);
        if (wrote)
            log.success(`Результат сохранён: ${wrote}`);
        return 0;
    }
    if (subcommand === "check") {
        const policy = readWardenPolicy(ctx.cwd);
        if (!policy) {
            throw new PilotError(`Политика не найдена: ${WARDEN_POLICY}`, {
                hint: "Создайте её: oc-pilot warden init.",
                exitCode: 2,
            });
        }
        const data = await loadDiff(values, ctx, [], { optionalGit: true });
        if (!data.diff.trim()) {
            log.info("Изменений нет — проверять политику не по чему.");
            return 0;
        }
        const report = checkWardenPolicy(data.diff, policy);
        const payload = { source: describeDiffSource(data.source), ...report };
        const wrote = ctx.flags.json
            ? writeOutput(JSON.stringify(payload, null, 2), ctx.flags.output)
            : writeOutput(report.content, ctx.flags.output);
        if (wrote)
            log.success(`Результат сохранён: ${wrote}`);
        if (report.status === "violation") {
            log.error(report.summary);
            return 1;
        }
        log.success(report.summary);
        return 0;
    }
    throw new PilotError("Неизвестная подкоманда warden", {
        hint: "Доступно: check, init, show.",
        exitCode: 2,
    });
}
//# sourceMappingURL=warden.js.map