import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { asBoolean, asString } from "../core/parse.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, withCommon } from "../core/options.js";
import { clearStats, readStats, summarizeStats, todayStartMs } from "../core/stats.js";
import { writeOutput } from "../core/io.js";
import { PilotError } from "../core/errors.js";
const OPTIONS = withCommon({
    clear: { type: "boolean" },
});
const HELP = `Использование:
  oc-pilot stats [опции]

Статистика использования oc-pilot: запуски, вызовы API, кеш, находки.

Опции:
      --clear              удалить накопленную статистику
${COMMON_HELP}

Данные хранятся локально в .git/oc-pilot/stats.jsonl и не покидают машину.

Примеры:
  oc-pilot stats
  oc-pilot stats --json
  oc-pilot stats --clear
`;
export async function runStats(argv) {
    const { values } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(HELP);
        return 0;
    }
    const cwdFlag = asString(values, "cwd");
    const cwd = cwdFlag ? resolve(cwdFlag) : process.cwd();
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
        throw new PilotError(`Каталог не найден: ${cwd}`);
    }
    if (asBoolean(values, "clear")) {
        clearStats(cwd);
        log.success("Статистика очищена.");
        return 0;
    }
    const records = readStats(cwd);
    const periods = {
        today: summarizeStats(records, todayStartMs()),
        week: summarizeStats(records, Date.now() - 7 * 24 * 60 * 60 * 1000),
        total: summarizeStats(records, 0),
    };
    if (asBoolean(values, "json") || values.format === "json") {
        writeOutput(JSON.stringify(periods, null, 2), asString(values, "output"));
        return 0;
    }
    for (const [label, summary] of [["Сегодня", periods.today], ["Неделя", periods.week], ["Всё время", periods.total]]) {
        log.info(`${label}: запусков ${summary.runs}, вызовов API ${summary.apiCalls}, из кеша ${summary.cacheHits}, ` +
            `находок ${summary.findings.critical} critical / ${summary.findings.warning} warning / ${summary.findings.style} style.`);
    }
    log.detail("Путь: .git/oc-pilot/stats.jsonl (в git-репозитории).");
    return 0;
}
//# sourceMappingURL=stats.js.map