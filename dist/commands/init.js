import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { configTemplate } from "../core/config.js";
import { PilotError } from "../core/errors.js";
import { log } from "../core/log.js";
import { parseCommandArgs } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";
import { combinePresets, getPreset, presetIds } from "../core/presets.js";
import { installHook } from "./install-hook.js";
const OPTIONS = {
    cwd: { type: "string", short: "C" },
    force: { type: "boolean" },
    hooks: { type: "boolean" },
    preset: { type: "string" },
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" },
};
const HELP = `Использование:
  oc-pilot init [опции]

Создаёт .oc-pilot.json с настройками по умолчанию, а с --preset —
ещё и .oc-pilot/rules.md с готовыми правилами для стека.

Опции:
  -C, --cwd <dir>       Директория проекта
      --force           Перезаписать существующие файлы
      --hooks           Установить git-хуки: preflight --staged на commit, review на push
      --preset <a,b>    Пресет правил, можно несколько через запятую:
                          ${presetIds().join(", ")}
      --json            Вывести пути в JSON
  -h, --help            Показать помощь
`;
export function runInit(argv) {
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
    const rawPreset = asString(values, "preset");
    let presets;
    if (rawPreset !== undefined) {
        const ids = rawPreset.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
        const unknown = ids.filter((id) => getPreset(id) === undefined);
        if (ids.length === 0 || unknown.length > 0) {
            throw new PilotError(`Неизвестный пресет: ${unknown[0] ?? rawPreset}`, {
                hint: `Доступны: ${presetIds().join(", ")}`,
                exitCode: 2,
            });
        }
        presets = ids.map((id) => getPreset(id));
    }
    const path = join(cwd, ".oc-pilot.json");
    const force = asBoolean(values, "force");
    if (existsSync(path) && !force && !presets) {
        throw new PilotError(`Конфиг уже существует: ${path}`, {
            hint: "Используйте --force для перезаписи.",
            exitCode: 2,
        });
    }
    if (existsSync(path) && !force) {
        log.info(`Конфиг уже существует: ${path} — оставлен без изменений.`);
    }
    else {
        writeFileSync(path, configTemplate(), "utf8");
        log.success(`Создан ${path}`);
    }
    let rulesPath;
    if (presets) {
        rulesPath = join(cwd, ".oc-pilot", "rules.md");
        if (existsSync(rulesPath) && !force) {
            throw new PilotError(`Файл правил уже существует: ${rulesPath}`, {
                hint: "Используйте --force для перезаписи.",
                exitCode: 2,
            });
        }
        mkdirSync(join(cwd, ".oc-pilot"), { recursive: true });
        const rulesText = presets.length === 1 ? presets[0].rules : combinePresets(presets);
        writeFileSync(rulesPath, rulesText, "utf8");
        const label = presets.length === 1
            ? `пресет ${presets[0].id}`
            : `пресеты ${presets.map((preset) => preset.id).join(", ")}`;
        log.success(`Создан ${rulesPath} (${label})`);
    }
    const hooks = [];
    if (asBoolean(values, "hooks")) {
        for (const kind of ["pre-commit", "pre-push"]) {
            try {
                const result = installHook(cwd, kind, force);
                hooks.push({ kind, path: result.path });
                log.success(`Установлен git-хук ${kind}: ${result.path}`);
            }
            catch (error) {
                log.warn(`Хук ${kind} не установлен: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
    if (asBoolean(values, "json")) {
        process.stdout.write(`${JSON.stringify({ created: path, ...(rulesPath ? { rules: rulesPath } : {}), ...(hooks.length > 0 ? { hooks } : {}) }, null, 2)}\n`);
        return 0;
    }
    log.blank();
    log.info("Дальше:");
    log.detail("oc-pilot review");
    log.detail("oc-pilot test-fix");
    log.detail('oc-pilot docgen "src/**/*.ts"');
    log.blank();
    if (presets) {
        log.info("Правила можно дополнять — они попадут в каждый запрос.");
    }
    else {
        log.info("Правила проекта: создайте .oc-pilot/rules.md (или init --preset <name>) — они попадут в каждый запрос.");
    }
    log.info("Агент по умолчанию — oc-pilot с read-only доступом к файлам. Модель берётся из конфигурации OpenCode.");
    return 0;
}
//# sourceMappingURL=init.js.map