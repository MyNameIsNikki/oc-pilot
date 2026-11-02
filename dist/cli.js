#!/usr/bin/env node
import { runCache } from "./commands/cache.js";
import { runCommit } from "./commands/commit.js";
import { runCustom } from "./commands/custom.js";
import { runDoctor } from "./commands/doctor.js";
import { runInstallHook } from "./commands/install-hook.js";
import { runRestore } from "./commands/restore.js";
import { runDocgen } from "./commands/docgen.js";
import { runFix } from "./commands/fix.js";
import { runInit } from "./commands/init.js";
import { runReview } from "./commands/review.js";
import { runScan } from "./commands/scan.js";
import { runSetup } from "./commands/setup.js";
import { runTestFix } from "./commands/test-fix.js";
import { PilotError, toPilotError } from "./core/errors.js";
import { log } from "./core/log.js";
import { COMMON_HELP } from "./core/options.js";
import { runMcp } from "./mcp.js";
import { VERSION } from "./version.js";
const HANDLERS = {
    review: runReview,
    "test-fix": runTestFix,
    fix: runFix,
    docgen: runDocgen,
    custom: runCustom,
    scan: runScan,
    commit: runCommit,
    "install-hook": runInstallHook,
    restore: runRestore,
    cache: runCache,
    setup: runSetup,
    doctor: runDoctor,
    mcp: runMcp,
    init: runInit,
};
const HELP = `oc-pilot ${VERSION} — AI-ревью, разбор тестов и документация для агентов

Использование:
  oc-pilot <команда> [опции]

Команды:
  review      Ревью git-diff: баги, уязвимости, идиомы языка
  test-fix    Разбор падения тестов и минимальный фикс
  fix         Патч от модели, git apply и цикл тестов с откатом
  docgen      Генерация GoDoc/RustDoc/JSDoc/docstrings
  custom      Свободный запрос к oc-pilot
  scan        Офлайн-поиск секретов в diff (без LLM)
  commit      Сгенерировать commit-сообщение по staged (--apply — закоммитить)

  install-hook  Установить git-хуки pre-commit/pre-push (scan/review)

  restore     Восстановить рабочее дерево из снимка fix --apply
  cache       Кеш ответов движка: --stats, --prune, --clear
  setup       Установить MCP-сервер в Claude Code, Cursor, OpenCode, Codex, Gemini, DeepSeek Harness, VS Code
  doctor      Проверить установку, движок, ключи, git и MCP-конфиги
  mcp         Запустить MCP-сервер (stdio или --http)
  init        Создать .oc-pilot.json
  version     Показать версию
  help        Показать помощь

Глобальные опции:
${COMMON_HELP}

Примеры:
  oc-pilot review
  oc-pilot review --base main --fail-on critical --fail-on-secrets
  oc-pilot review --no-repo-context
  oc-pilot fix --apply --command "go test ./..."
  oc-pilot test-fix --command "go test ./..."
  oc-pilot docgen "src/**/*.ts" --symbol buildPrompt
  git diff | oc-pilot scan --stdin
  oc-pilot commit --apply
  oc-pilot custom "Найди гонки данных" --git-diff
  oc-pilot setup --all
  oc-pilot setup --client claude --http https://example.com/mcp --token "$OC_PILOT_MCP_TOKEN"
  oc-pilot doctor
  oc-pilot review --engine openai --model deepseek-chat --base-url https://api.deepseek.com/v1
  oc-pilot mcp --cwd /path/to/project

Коды возврата:
  0 — успех
  1 — ошибка выполнения
  2 — ошибка аргументов
  3 — политика (--fail-on-secrets / --fail-on / --strict)
`;
async function main(argv) {
    const command = argv[0];
    if (!command || command === "--help" || command === "-h" || command === "help") {
        if (command === "help" && argv[1] && HANDLERS[argv[1]]) {
            return HANDLERS[argv[1]](["--help"]);
        }
        process.stdout.write(HELP);
        return 0;
    }
    if (command === "--version" || command === "-v" || command === "version") {
        process.stdout.write(`oc-pilot ${VERSION}\n`);
        return 0;
    }
    const handler = HANDLERS[command];
    if (!handler) {
        if (command.startsWith("-")) {
            throw new PilotError(`Неизвестная глобальная опция: ${command}`, {
                hint: "Сначала укажите команду, например: oc-pilot review --help",
                exitCode: 2,
            });
        }
        throw new PilotError(`Неизвестная команда: ${command}`, {
            hint: "Доступные команды: review, test-fix, fix, docgen, custom, scan, commit, install-hook, restore, cache, setup, init.",
            exitCode: 2,
        });
    }
    return handler(argv.slice(1));
}
process.stdout.on("error", (error) => {
    if (error.code === "EPIPE")
        process.exit(0);
    throw error;
});
main(process.argv.slice(2))
    .then((code) => {
    process.exitCode = code;
})
    .catch((error) => {
    const pilot = toPilotError(error);
    log.error(pilot.message);
    if (pilot.hint) {
        for (const line of pilot.hint.split(/\r?\n/))
            log.detail(line);
    }
    if (!(error instanceof PilotError) && process.env.OC_PILOT_DEBUG) {
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    }
    process.exitCode = pilot.exitCode;
});
//# sourceMappingURL=cli.js.map