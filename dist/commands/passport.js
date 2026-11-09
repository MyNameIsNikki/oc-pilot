import { clearPassport, createPassport, parsePassportCheck, readPassport, renderPassport, renderPassportMarkdown, verifyPassport, } from "../core/passport.js";
import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";
const OPTIONS = withCommon({
    commit: { type: "string" },
    agent: { type: "string" },
    model: { type: "string" },
    "prompt-hash": { type: "string" },
    check: { type: "string", multiple: true },
    "include-untracked": { type: "boolean" },
    markdown: { type: "boolean" },
    force: { type: "boolean" },
});
const HELP = `Использование:
  oc-pilot passport write [--commit <ref>] [опции]
  oc-pilot passport verify
  oc-pilot passport show [--markdown]
  oc-pilot passport clear --force

Паспорт — это манифест происхождения изменения: коммит, tree, файлы с
хешами, агент, модель и записанные проверки. Digest связывает манифест
с содержимым, поэтому подмена или устаревание видны при verify.
Commit-паспорт неизменяем и проверяется по своему коммиту; worktree-паспорт
действует, пока HEAD и файлы не изменились. Pass ставится только когда есть
хотя бы одна проверка и нет fail/warn.

Опции:
      --commit <ref>      commit-паспорт для указанного коммита
      --agent <name>      кто внёс изменение
      --model <name>      какая модель использовалась
      --prompt-hash <h>   хеш промпта или сессии
      --check <name=...>  проверка: name=pass|warn|fail|skip (можно несколько)
      --include-untracked включить неотслеживаемые файлы в worktree-паспорт
      --markdown          show в виде Markdown для PR
      --force             подтвердить clear
${COMMON_HELP}

Примеры:
  oc-pilot passport write --agent claude-code --model opus-4 --check tests=pass
  oc-pilot passport write --commit HEAD --check preflight=pass
  oc-pilot passport verify
  oc-pilot passport show --markdown`;
function strings(values, key) {
    const value = values[key];
    if (value === undefined)
        return [];
    if (Array.isArray(value))
        return value.filter((item) => typeof item === "string");
    if (typeof value === "string")
        return [value];
    throw new PilotError(`--${key} ожидает значение`, { exitCode: 2 });
}
export async function runPassport(argv) {
    const { values, positionals } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(`${HELP}\n`);
        return 0;
    }
    const [subcommand] = positionals;
    const ctx = resolveContext(values);
    if (subcommand === "write") {
        const ref = asString(values, "commit");
        const checks = strings(values, "check").map(parsePassportCheck);
        const manifest = createPassport(ctx.cwd, {
            mode: ref ? "commit" : "worktree",
            ref,
            agent: asString(values, "agent"),
            model: asString(values, "model"),
            promptHash: asString(values, "prompt-hash"),
            checks,
            includeUntracked: asBoolean(values, "include-untracked"),
        });
        const wrote = ctx.flags.json
            ? writeOutput(JSON.stringify(manifest, null, 2), ctx.flags.output)
            : writeOutput(renderPassport(manifest), ctx.flags.output);
        if (wrote)
            log.success(`Результат сохранён: ${wrote}`);
        log.success(`Паспорт записан: .oc-pilot/passport.json`);
        return 0;
    }
    if (subcommand === "verify") {
        const result = verifyPassport(ctx.cwd);
        const wrote = ctx.flags.json
            ? writeOutput(JSON.stringify(result, null, 2), ctx.flags.output)
            : writeOutput(result.content, ctx.flags.output);
        if (wrote)
            log.success(`Результат сохранён: ${wrote}`);
        if (result.status === "valid") {
            log.success(result.summary);
            return 0;
        }
        log.error(result.summary);
        return result.status === "missing" || result.status === "error" ? 2 : 1;
    }
    if (subcommand === "show") {
        const manifest = readPassport(ctx.cwd);
        if (!manifest) {
            throw new PilotError("Паспорт не найден", {
                hint: "Сначала выполните oc-pilot passport write.",
                exitCode: 2,
            });
        }
        const text = asBoolean(values, "markdown")
            ? renderPassportMarkdown(manifest)
            : renderPassport(manifest);
        const wrote = ctx.flags.json
            ? writeOutput(JSON.stringify(manifest, null, 2), ctx.flags.output)
            : writeOutput(text, ctx.flags.output);
        if (wrote)
            log.success(`Результат сохранён: ${wrote}`);
        return 0;
    }
    if (subcommand === "clear") {
        if (!asBoolean(values, "force")) {
            throw new PilotError("clear удаляет паспорт; добавьте --force", {
                hint: "Проверить паспорт: oc-pilot passport show.",
                exitCode: 2,
            });
        }
        const result = clearPassport(ctx.cwd);
        if (ctx.flags.json)
            writeOutput(JSON.stringify(result, null, 2), ctx.flags.output);
        else
            process.stdout.write(`Passport: ${result.removed ? "удалён" : "не найден"}.\n`);
        return 0;
    }
    throw new PilotError("Неизвестная подкоманда passport", {
        hint: "Доступно: write, verify, show, clear.",
        exitCode: 2,
    });
}
//# sourceMappingURL=passport.js.map