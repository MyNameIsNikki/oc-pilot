import { buildVaccinePrompt, clearVaccines, forgetVaccine, listVaccines, renderVaccineVerification, runVaccines, storeVaccine, verifyVaccine, } from "../core/vaccine.js";
import { PilotError } from "../core/errors.js";
import { runGit } from "../core/git.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";
import { detectProjectType } from "../core/project.js";
import { executeRecipeDetailed } from "../core/run.js";
import { parseSkepticHypothesis, parseSkepticTimeout } from "../core/skeptic.js";
const OPTIONS = withCommon({
    fix: { type: "string" },
    bug: { type: "string" },
    command: { type: "string" },
    context: { type: "string" },
    "test-timeout": { type: "string" },
    "dry-run": { type: "boolean" },
    id: { type: "string" },
    force: { type: "boolean" },
});
const HELP = `Использование:
  oc-pilot vaccine create [--fix HEAD] [--bug <ref>] [опции]
  oc-pilot vaccine run [--command <cmd>]
  oc-pilot vaccine list
  oc-pilot vaccine forget --id <id>
  oc-pilot vaccine clear --force

Вакцина — это регрессионный тест, который падает на баге и проходит на
исправлении. create просит модель написать тест, проверяет его в двух
shadow worktree и сохраняет только доказанную вакцину в .oc-pilot/vaccines.
run прогоняет все вакцины на текущем HEAD.

Статусы create:
  [VACCINE VERIFIED]  тест падает на баге и проходит на исправлении
  [VACCINE REJECTED]  тест не различает баг и исправление
  [VACCINE ERROR]     тест или проверка не запустились

Опции:
      --fix <ref>           исправленный коммит (по умолчанию HEAD)
      --bug <ref>           багованный коммит (по умолчанию родитель --fix)
      --command <cmd>       команда теста с {file} (по умолчанию node --test {file})
      --context <text>      что именно сломалось
      --test-timeout <120s> таймаут одного прогона
      --dry-run             показать промпт без вызова модели
      --id <id>             вакцина для forget
      --force               подтвердить clear
${COMMON_HELP}

Коды выхода create:
  0  вакцина доказана и сохранена
  1  тест не различает баг и исправление
  2  ошибка модели, git или запуска теста

Примеры:
  oc-pilot vaccine create --fix HEAD --context "скидка на отрицательную сумму"
  oc-pilot vaccine create --bug HEAD~3 --fix HEAD~2
  oc-pilot vaccine run
  oc-pilot vaccine list --json`;
function resolveCommit(cwd, ref) {
    if (!ref || ref.startsWith("-")) {
        throw new PilotError(`Некорректная ссылка: ${ref}`, { exitCode: 2 });
    }
    const result = runGit(["rev-parse", "--verify", `${ref}^{commit}`], cwd);
    if (result.status !== 0) {
        throw new PilotError(`Коммит не найден: ${ref}`, {
            hint: result.stderr.trim() || undefined,
            exitCode: 2,
        });
    }
    return result.stdout.trim();
}
export async function runVaccine(argv) {
    const { values, positionals } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(`${HELP}\n`);
        return 0;
    }
    const [subcommand] = positionals;
    const ctx = resolveContext(values);
    if (subcommand === "create") {
        const fixRef = asString(values, "fix") ?? "HEAD";
        const fixSha = resolveCommit(ctx.cwd, fixRef);
        const bugRef = asString(values, "bug");
        let bugSha;
        if (bugRef) {
            bugSha = resolveCommit(ctx.cwd, bugRef);
        }
        else {
            const parent = runGit(["rev-parse", "--verify", `${fixSha}^`], ctx.cwd);
            if (parent.status !== 0) {
                throw new PilotError("У исправленного коммита нет родителя", {
                    hint: "Укажите багованный коммит через --bug.",
                    exitCode: 2,
                });
            }
            bugSha = parent.stdout.trim();
        }
        const diff = runGit(["diff", "--no-color", "--no-ext-diff", bugSha, fixSha], ctx.cwd);
        if (diff.status !== 0) {
            throw new PilotError("Не удалось получить diff исправления", {
                hint: diff.stderr.trim() || undefined,
                exitCode: 2,
            });
        }
        if (!diff.stdout.trim()) {
            log.info("Между багом и исправлением нет diff — вакцину создать не из чего.");
            return 0;
        }
        const fixDiff = diff.stdout.length > 80_000 ? diff.stdout.slice(0, 80_000) : diff.stdout;
        const prompt = buildVaccinePrompt(fixDiff, bugSha, fixSha, asString(values, "context"));
        if (asBoolean(values, "dry-run")) {
            const wrote = writeOutput(prompt, ctx.flags.output);
            if (wrote)
                log.success(`Промпт сохранён: ${wrote}`);
            return 0;
        }
        const result = await executeRecipeDetailed({
            recipe: "custom",
            projectType: detectProjectType(ctx.cwd, []),
            additionalContext: prompt,
            diff: "",
            secretFindings: [],
            changedFiles: [],
            failOnSecrets: false,
            noSecretScan: true,
            meta: { source: `vaccine ${bugSha.slice(0, 8)}..${fixSha.slice(0, 8)}` },
        }, ctx);
        const hypothesis = parseSkepticHypothesis(result.analysis ?? "");
        if (!hypothesis) {
            const wrote = ctx.flags.json
                ? writeOutput(JSON.stringify({ status: "error", summary: "[VACCINE ERROR]: модель не вернула JSON-тест." }, null, 2), ctx.flags.output)
                : writeOutput("[VACCINE ERROR]: модель не вернула JSON-тест.\n", ctx.flags.output);
            if (wrote)
                log.success(`Результат сохранён: ${wrote}`);
            log.error("[VACCINE ERROR]: модель не вернула JSON-тест.");
            return 2;
        }
        const verification = await verifyVaccine(ctx.cwd, bugSha, fixSha, hypothesis, {
            command: asString(values, "command"),
            timeoutMs: parseSkepticTimeout(asString(values, "test-timeout")),
        });
        const wrote = ctx.flags.json
            ? writeOutput(JSON.stringify(verification, null, 2), ctx.flags.output)
            : writeOutput(renderVaccineVerification(verification), ctx.flags.output);
        if (wrote)
            log.success(`Результат сохранён: ${wrote}`);
        if (verification.status === "verified") {
            const record = storeVaccine(ctx.cwd, {
                bug: bugSha,
                fix: fixSha,
                command: asString(values, "command") ?? "node --test {file}",
                reason: hypothesis.reason,
                test: hypothesis.test,
            });
            log.success(`${verification.summary} Сохранено: ${record.testFile}`);
            return 0;
        }
        if (verification.status === "rejected") {
            log.warn(verification.summary);
            return 1;
        }
        log.error(verification.summary);
        return 2;
    }
    if (subcommand === "run") {
        const report = await runVaccines(ctx.cwd, {
            command: asString(values, "command"),
            timeoutMs: parseSkepticTimeout(asString(values, "test-timeout")),
        });
        const wrote = ctx.flags.json
            ? writeOutput(JSON.stringify(report, null, 2), ctx.flags.output)
            : writeOutput(report.content, ctx.flags.output);
        if (wrote)
            log.success(`Результат сохранён: ${wrote}`);
        if (report.total === 0) {
            log.info(report.summary);
            return 0;
        }
        if (report.failed > 0) {
            log.error(report.summary);
            return 1;
        }
        log.success(report.summary);
        return 0;
    }
    if (subcommand === "list") {
        const report = listVaccines(ctx.cwd);
        const wrote = ctx.flags.json
            ? writeOutput(JSON.stringify(report, null, 2), ctx.flags.output)
            : writeOutput(report.content, ctx.flags.output);
        if (wrote)
            log.success(`Результат сохранён: ${wrote}`);
        return 0;
    }
    if (subcommand === "forget") {
        const id = asString(values, "id");
        if (!id) {
            throw new PilotError("Укажите --id вакцины", {
                hint: "Список: oc-pilot vaccine list.",
                exitCode: 2,
            });
        }
        const result = forgetVaccine(ctx.cwd, id);
        if (!result.removed) {
            log.warn(`Вакцина ${id} не найдена.`);
            return 1;
        }
        if (ctx.flags.json)
            writeOutput(JSON.stringify(result, null, 2), ctx.flags.output);
        else
            process.stdout.write(`Vaccine: удалено 1, осталось ${String(result.remaining)}.\n`);
        return 0;
    }
    if (subcommand === "clear") {
        if (!asBoolean(values, "force")) {
            throw new PilotError("clear удаляет все вакцины; добавьте --force", {
                hint: "Проверить вакцины: oc-pilot vaccine list.",
                exitCode: 2,
            });
        }
        const result = clearVaccines(ctx.cwd);
        if (ctx.flags.json)
            writeOutput(JSON.stringify(result, null, 2), ctx.flags.output);
        else
            process.stdout.write(`Vaccine: удалено ${String(result.removed)}.\n`);
        return 0;
    }
    throw new PilotError("Неизвестная подкоманда vaccine", {
        hint: "Доступно: create, run, list, forget, clear.",
        exitCode: 2,
    });
}
//# sourceMappingURL=vaccine.js.map