import { existsSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { configTemplate } from "../core/config.js";
import { PilotError } from "../core/errors.js";
import { log } from "../core/log.js";
import { parseCommandArgs, type OptionSpec } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";

const OPTIONS: OptionSpec = {
  cwd: { type: "string", short: "C" },
  force: { type: "boolean" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

const HELP = `Использование:
  oc-pilot init [опции]

Создаёт .oc-pilot.json с настройками по умолчанию.

Опции:
  -C, --cwd <dir>   Директория проекта
      --force       Перезаписать существующий конфиг
      --json        Вывести путь в JSON
  -h, --help        Показать помощь
`;

export function runInit(argv: string[]): number {
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

  const path = join(cwd, ".oc-pilot.json");
  if (existsSync(path) && !asBoolean(values, "force")) {
    throw new PilotError(`Конфиг уже существует: ${path}`, {
      hint: "Используйте --force для перезаписи.",
      exitCode: 2,
    });
  }

  writeFileSync(path, configTemplate(), "utf8");

  if (asBoolean(values, "json")) {
    process.stdout.write(`${JSON.stringify({ created: path }, null, 2)}\n`);
    return 0;
  }

  log.success(`Создан ${path}`);
  log.blank();
  log.info("Дальше:");
  log.detail("oc-pilot review");
  log.detail("oc-pilot test-fix");
  log.detail('oc-pilot docgen "src/**/*.ts"');
  log.blank();
  log.info("Правила проекта: создайте .oc-pilot/rules.md — они попадут в каждый запрос.");
  log.info("Агент по умолчанию — oc-pilot с read-only доступом к файлам. Модель берётся из конфигурации OpenCode.");
  return 0;
}
