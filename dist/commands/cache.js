import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { cacheStats, clearCache, pruneCache } from "../core/cache.js";
import { PilotError } from "../core/errors.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, withCommon } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";
const OPTIONS = withCommon({
    stats: { type: "boolean" },
    prune: { type: "boolean" },
    clear: { type: "boolean" },
});
const HELP = `Использование:
  oc-pilot cache [опции]

Управление кешем ответов движка (engine=openai). Кеш лежит в
.git/oc-pilot/cache, ключ — хеш промпта и модели, TTL — cacheTtlSeconds.

Без опций печатает статистику.

Опции:
      --stats            Показать статистику кеша (по умолчанию)
      --prune            Удалить только просроченные записи
      --clear            Удалить все записи кеша
${COMMON_HELP}

Примеры:
  oc-pilot cache
  oc-pilot cache --prune
  oc-pilot cache --clear
`;
export async function runCache(argv) {
    const { values } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(HELP);
        return 0;
    }
    const rawCwd = asString(values, "cwd");
    const cwd = rawCwd ? resolve(process.cwd(), rawCwd) : process.cwd();
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
        throw new PilotError(`Директория не найдена: ${cwd}`, { exitCode: 2 });
    }
    const stats = cacheStats(cwd);
    if (!stats) {
        log.info("Кеш недоступен: нужен git-репозиторий (кеш живёт в .git/oc-pilot/cache).");
        return 0;
    }
    if (asBoolean(values, "clear")) {
        const removed = clearCache(cwd);
        log.success(`Кеш очищен: удалено записей: ${removed}.`);
        return 0;
    }
    if (asBoolean(values, "prune")) {
        const removed = pruneCache(cwd);
        log.success(`Просроченные записи удалены: ${removed}.`);
        return 0;
    }
    log.info(`Записей: ${stats.entries} · размер: ${Math.round(stats.bytes / 1024)} KB · просрочено: ${stats.expired}.`);
    log.detail("Путь: .git/oc-pilot/cache");
    return 0;
}
//# sourceMappingURL=cache.js.map