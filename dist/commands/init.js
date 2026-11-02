import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { configTemplate } from "../core/config.js";
import { PilotError } from "../core/errors.js";
import { log } from "../core/log.js";
import { parseCommandArgs } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";
import { getPreset, presetIds } from "../core/presets.js";
const OPTIONS = {
    cwd: { type: "string", short: "C" },
    force: { type: "boolean" },
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
      --preset <name>   Пресет правил: ${presetIds().join(", ")}
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
    const presetId = asString(values, "preset");
    const preset = presetId !== undefined ? getPreset(presetId) : undefined;
    if (presetId !== undefined && !preset) {
        throw new PilotError(`Неизвестный пресет: ${presetId}`, {
            hint: `Доступны: ${presetIds().join(", ")}`,
            exitCode: 2,
        });
    }
    const path = join(cwd, ".oc-pilot.json");
    const force = asBoolean(values, "force");
    if (existsSync(path) && !force && !preset) {
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
    if (preset) {
        rulesPath = join(cwd, ".oc-pilot", "rules.md");
        if (existsSync(rulesPath) && !force) {
            throw new PilotError(`Файл правил уже существует: ${rulesPath}`, {
                hint: "Используйте --force для перезаписи.",
                exitCode: 2,
            });
        }
        mkdirSync(join(cwd, ".oc-pilot"), { recursive: true });
        writeFileSync(rulesPath, preset.rules, "utf8");
        log.success(`Создан ${rulesPath} (пресет ${preset.id})`);
    }
    if (asBoolean(values, "json")) {
        process.stdout.write(`${JSON.stringify({ created: path, ...(rulesPath ? { rules: rulesPath } : {}) }, null, 2)}\n`);
        return 0;
    }
    log.blank();
    log.info("Дальше:");
    log.detail("oc-pilot review");
    log.detail("oc-pilot test-fix");
    log.detail('oc-pilot docgen "src/**/*.ts"');
    log.blank();
    if (preset) {
        log.info("Правила можно дополнять — они попадут в каждый запрос.");
    }
    else {
        log.info("Правила проекта: создайте .oc-pilot/rules.md (или init --preset <name>) — они попадут в каждый запрос.");
    }
    log.info("Агент по умолчанию — oc-pilot с read-only доступом к файлам. Модель берётся из конфигурации OpenCode.");
    return 0;
}
//# sourceMappingURL=init.js.map