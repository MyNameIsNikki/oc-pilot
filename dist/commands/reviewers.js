import { loadDiff } from "../core/diff-source.js";
import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";
import { describeReviewers, suggestReviewers } from "../core/reviewers.js";
const OPTIONS = withCommon({
    staged: { type: "boolean" },
    unstaged: { type: "boolean" },
    base: { type: "string" },
    diff: { type: "string" },
    stdin: { type: "boolean" },
    "include-untracked": { type: "boolean" },
    limit: { type: "string" },
    depth: { type: "string" },
    exclude: { type: "string" },
});
const HELP = `Использование:
  oc-pilot reviewers [пути] [опции]

Предлагает, кому назначить ревью: считает, кто чаще всего трогал файлы
из текущего diff, и складывает это с CODEOWNERS. Только git, без сети
и без вызова модели.

Опции:
      --staged              изменения в индексе (git diff --cached)
      --unstaged            только unstaged-изменения
      --base <ref>          diff относительно ветки (например, main)
      --diff <file|->       готовый diff из файла или stdin
      --stdin               читать diff из стандартного ввода
      --include-untracked   включить новые неотслеживаемые файлы
      --limit <n>           сколько кандидатов показать (по умолчанию 3)
      --depth <n>           сколько последних коммитов на файл смотреть (по умолчанию 50)
      --exclude <a,b>       исключить авторов по имени или email (подстрока)
${COMMON_HELP}

Примеры:
  oc-pilot reviewers --base main
  oc-pilot reviewers --staged --limit 5 --json
  oc-pilot reviewers --diff pr.diff --exclude dependabot
`;
function positiveInt(raw, flag, fallback, max) {
    if (raw === undefined)
        return fallback;
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value) || value < 1 || value > max) {
        throw new PilotError(`Некорректное значение --${flag}: ${raw}`, {
            hint: `Укажите целое число от 1 до ${String(max)}.`,
            exitCode: 2,
        });
    }
    return value;
}
export async function runReviewers(argv) {
    const { values, positionals } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(HELP);
        return 0;
    }
    const ctx = resolveContext(values);
    const limit = positiveInt(asString(values, "limit"), "limit", 3, 20);
    const depth = positiveInt(asString(values, "depth"), "depth", 50, 5_000);
    const exclude = (asString(values, "exclude") ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    const data = await loadDiff(values, ctx, positionals);
    if (data.changedFiles.length === 0) {
        log.info("Изменённых файлов нет — назначать некого.");
        return 0;
    }
    const report = suggestReviewers(ctx.cwd, data.changedFiles, { limit, depth, exclude });
    if (report.candidates.length === 0) {
        log.warn("git-история по этим файлам пустая: репозиторий новый или файлы добавлены только сейчас.");
    }
    if (ctx.flags.json) {
        writeOutput(JSON.stringify(report, null, 2), ctx.flags.output);
        return 0;
    }
    const wrote = writeOutput(describeReviewers(report), ctx.flags.output);
    if (wrote)
        log.success(`Отчёт сохранён: ${wrote}`);
    return 0;
}
//# sourceMappingURL=reviewers.js.map