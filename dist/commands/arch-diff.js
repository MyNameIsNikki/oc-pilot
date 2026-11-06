import { analyzeArchDiff, describeArchDiff, renderMermaid } from "../core/arch-diff.js";
import { loadDiff } from "../core/diff-source.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString, parsePositiveInt } from "../core/parse.js";
const OPTIONS = withCommon({
    diff: { type: "string" },
    staged: { type: "boolean" },
    unstaged: { type: "boolean" },
    base: { type: "string" },
    "include-untracked": { type: "boolean" },
    "max-edges": { type: "string" },
    "fail-on-removed": { type: "boolean" },
});
const HELP = `Использование:
  oc-pilot arch-diff [пути] [опции]

Строит Mermaid-схему архитектурных связей, которые diff добавил или удалил.
Зелёные стрелки — новые импорты, красные пунктирные — удалённые. Схему можно
вставить в описание pull request, и GitHub отрисует её автоматически.
Пакетные импорты в схему не попадают: только связи между файлами репозитория.
Модель и сеть не используются.

Опции:
      --max-edges <n>       максимум связей на схеме (по умолчанию 200)
      --fail-on-removed     код 1, если diff удалил хотя бы одну связь
      --diff <file>         готовый unified diff вместо git-состояния
      --staged              только staged-изменения
      --unstaged            только unstaged-изменения
      --base <ref>          diff <ref>...HEAD
      --include-untracked   включить неотслеживаемые файлы
${COMMON_HELP}

Примеры:
  oc-pilot arch-diff --staged
  oc-pilot arch-diff --base main --fail-on-removed
  oc-pilot arch-diff --diff changes.diff --json
  oc-pilot arch-diff --staged --output arch.md`;
export async function runArchDiff(argv) {
    const { values, positionals } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(HELP);
        return 0;
    }
    const maxRaw = asString(values, "max-edges");
    const maxEdges = maxRaw ? parsePositiveInt(maxRaw, "max-edges", 2000) : 200;
    const failOnRemoved = asBoolean(values, "fail-on-removed");
    const ctx = resolveContext(values);
    const data = await loadDiff(values, ctx, positionals, { optionalGit: true });
    if (!data.diff.trim()) {
        log.info("Изменений нет — архитектурных сдвигов не найдено.");
        return 0;
    }
    const report = analyzeArchDiff(ctx.cwd, data.diff, { maxEdges });
    const failed = failOnRemoved && report.removed.length > 0;
    if (ctx.flags.json) {
        const payload = {
            source: data.source,
            ...report,
            gate: { failOnRemoved, passed: !failed },
        };
        const wrote = writeOutput(JSON.stringify(payload, null, 2), ctx.flags.output);
        if (wrote)
            log.success(`Отчёт сохранён: ${wrote}`);
        if (failed)
            log.error(`Удалённых архитектурных связей: ${String(report.removed.length)}.`);
        return failed ? 1 : 0;
    }
    const wrote = writeOutput(renderMermaid(report), ctx.flags.output);
    if (wrote)
        log.success(`Схема сохранена: ${wrote}`);
    log.detail(describeArchDiff(report));
    if (report.truncated)
        log.warn("Схема усечена лимитом --max-edges.");
    if (failed)
        log.error(`Удалённых архитектурных связей: ${String(report.removed.length)}.`);
    return failed ? 1 : 0;
}
//# sourceMappingURL=arch-diff.js.map