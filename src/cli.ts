#!/usr/bin/env node
import { runCache } from "./commands/cache.js";
import { runDay } from "./commands/day.js";
import { runDeps } from "./commands/deps.js";
import { runEcosystemVerify } from "./commands/ecosystem-verify.js";
import { runEnvSync } from "./commands/env-sync.js";
import { runMockLeak } from "./commands/mock-leak.js";
import { runCoverage } from "./commands/coverage.js";
import { runPack } from "./commands/pack.js";
import { runContractDrift } from "./commands/contract-drift.js";
import { runAntiRegression } from "./commands/anti-regression.js";
import { runBoundaries } from "./commands/boundaries.js";
import { runTestPlan } from "./commands/test-plan.js";
import { runCompliance } from "./commands/compliance.js";
import { runBrag } from "./commands/brag.js";
import { runBattleCommand } from "./commands/battle.js";
import { runCleanup } from "./commands/cleanup.js";
import { runArchDiff } from "./commands/arch-diff.js";
import { runRoast } from "./commands/roast.js";
import { runCinema } from "./commands/cinema.js";
import { runBounty } from "./commands/bounty.js";
import { runAutopsy } from "./commands/autopsy.js";
import { runEcho } from "./commands/echo.js";
import { runImpact } from "./commands/impact.js";
import { runExplain } from "./commands/explain.js";
import { runStats } from "./commands/stats.js";
import { runCommit } from "./commands/commit.js";
import { runCustom } from "./commands/custom.js";
import { runDoctor } from "./commands/doctor.js";
import { runInstallHook } from "./commands/install-hook.js";
import { runPreflight } from "./commands/preflight.js";
import { runReceipt } from "./commands/receipt.js";
import { runReady } from "./commands/ready.js";
import { runRestore } from "./commands/restore.js";
import { runDocgen } from "./commands/docgen.js";
import { runFix } from "./commands/fix.js";
import { runInit } from "./commands/init.js";
import { runReplay } from "./commands/replay.js";
import { runReview } from "./commands/review.js";
import { runReviewers } from "./commands/reviewers.js";
import { runSlop } from "./commands/slop.js";
import { runScan } from "./commands/scan.js";
import { runSetup } from "./commands/setup.js";
import { runTestFix } from "./commands/test-fix.js";
import { runTestGen } from "./commands/test-gen.js";
import { runTestGuard } from "./commands/test-guard.js";
import { runFlaky } from "./commands/flaky.js";
import { runMutate } from "./commands/mutate.js";
import { runSast } from "./commands/sast.js";
import { runAuthz } from "./commands/authz.js";
import { PilotError, toPilotError } from "./core/errors.js";
import { log } from "./core/log.js";
import { COMMON_HELP } from "./core/options.js";
import { runMcp } from "./mcp.js";
import { VERSION } from "./version.js";

type Handler = (args: string[]) => Promise<number> | number;

const HANDLERS: Record<string, Handler> = {
  review: runReview,
  reviewers: runReviewers,
  "test-fix": runTestFix,
  "test-gen": runTestGen,
  "test-guard": runTestGuard,
  flaky: runFlaky,
  mutate: runMutate,
  sast: runSast,
  authz: runAuthz,
  fix: runFix,
  docgen: runDocgen,
  custom: runCustom,
  scan: runScan,
  deps: runDeps,
  "ecosystem-verify": runEcosystemVerify,
  "env-sync": runEnvSync,
  "mock-leak": runMockLeak,
  coverage: runCoverage,
  pack: runPack,
  "contract-drift": runContractDrift,
  "anti-regression": runAntiRegression,
  boundaries: runBoundaries,
  "test-plan": runTestPlan,
  compliance: runCompliance,
  brag: runBrag,
  battle: runBattleCommand,
  cleanup: runCleanup,
  "arch-diff": runArchDiff,
  roast: runRoast,
  cinema: runCinema,
  bounty: runBounty,
  autopsy: runAutopsy,
  echo: runEcho,
  preflight: runPreflight,
  receipt: runReceipt,
  ready: runReady,
  commit: runCommit,
  "install-hook": runInstallHook,
  restore: runRestore,
  cache: runCache,
  stats: runStats,
  day: runDay,
  impact: runImpact,
  explain: runExplain,
  replay: runReplay,
  slop: runSlop,
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
  test-gen    Сгенерировать тесты на изменённый код и оставить только зелёные
  test-guard  Найти ослабление тестов: skip, удалённые проверки, матчеры
  flaky       Найти нестабильные тесты: несколько прогонов и сравнение
  mutate      Мутационное тестирование: проверить, что тесты ловят баги
  sast        Детерминированный SAST: инъекции, SSRF, path traversal, XSS
  authz       Проверка маршрутов: авторизация, IDOR, админ-доступ
  fix         Патч от модели, git apply и цикл тестов с откатом
  docgen      Генерация GoDoc/RustDoc/JSDoc/docstrings
  custom      Свободный запрос к oc-pilot
  scan        Офлайн-поиск секретов в diff (без LLM)
  deps        Аудит зависимостей: фантомные импорты, лишние пакеты, lockfile
  ecosystem-verify  Проверить импорты и новые пакеты: выдуманные API, свежие зависимости
  env-sync    Переменные окружения из diff против .env и .env.example
  mock-leak   Заглушки и хардкод в прод-коде: пути, токены, if (true)
  coverage    Покрытие изменённых строк: непокрытые строки и гейт
  pack        Собрать компактный контекст задачи: подписи, связи, правила
  contract-drift  Дрейф контрактов: удалённые поля, типы, потребители
  anti-regression  Повторно добавленные строки, которые человек уже удалял
  boundaries  Границы слоёв: запрещённые импорты между модулями
  test-plan   Выбрать тесты, затронутые изменением, по графу импортов
  compliance  Подписанный аудит-манифест коммита: квитанция, проверки, SBOM
  brag        Локальная HTML-страница о работе: коммиты, запуски, находки
  battle      Два агента: Coder чинит, Hacker ищет дыры, до чистого состояния
  cleanup     План уборки: зависимости, slop, env, тесты
  roast       Прожарка diff: токсичный сеньор с конкретными претензиями
  arch-diff   Mermaid-схема добавленных и удалённых архитектурных связей
  cinema      Терминальный таймлапс сессии: коммиты, запуски, находки
  bounty      ASCII-плакат WANTED для самого проблемного файла
  autopsy     Разбор коммита: улики, подозреваемые и хронология
  echo        SVG-бейджи и опциональная анонимная отправка статистики
  preflight   Офлайн-проверка изменения: секреты, зависимости, тесты, slop
  receipt     Квитанция о тестах и preflight, привязанная к коммиту
  ready       Оценить готовность репозитория к работе с ИИ-агентом
  commit      Сгенерировать commit-сообщение по staged (--apply — закоммитить)

  install-hook  Установить git-хуки pre-commit/pre-push (preflight/review)

  restore     Восстановить рабочее дерево из снимка fix --apply
  cache       Кеш ответов движка: --stats, --prune, --clear
  stats       Статистика использования: запуски, кеш, находки (--clear)
  day         Сводка активности агента за период (--since)
  impact      Показать, где ещё используются изменённые в diff символы
  explain     Объяснить находки последнего ревью для файла:строки
  reviewers   Предложить ревьюеров по истории файлов из diff и CODEOWNERS
  replay      Вывести последнее сохранённое ревью в text/json/sarif/md
  slop        Slop Index 0-100: дубликаты, мёртвый код, churn и TODO-кладбище
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
  oc-pilot test-gen --staged --apply
  oc-pilot test-guard --staged --fail-on-weakening
  oc-pilot flaky --runs 5
  oc-pilot mutate --staged --min-score 80
  oc-pilot coverage --staged --coverage-file coverage/lcov.info --fail-under 80
  oc-pilot env-sync --staged --fail-on-missing
  oc-pilot mock-leak --staged --fail-on-leak high
  oc-pilot pack "fix the login redirect" --staged --budget 12000
  oc-pilot contract-drift --staged --fail-on-drift high
  oc-pilot anti-regression --staged --fail-on-regression
  oc-pilot boundaries --init
  oc-pilot boundaries --staged --fail-on-violation
  oc-pilot test-plan --staged --fail-on-uncovered
  oc-pilot compliance --sign --key receipt.key
  oc-pilot brag --since-days 30 --output brag.html
  oc-pilot battle "fix the retry logic" --apply --rounds 3
  oc-pilot cleanup --staged --fail-on-task high
  oc-pilot arch-diff --staged --fail-on-removed
  oc-pilot roast --staged --persona linus
  oc-pilot cinema --since-days 30 --output cinema.html
  oc-pilot bounty --limit 10 --since-days 90
  oc-pilot autopsy HEAD~1 --depth 10
  oc-pilot echo --name my-team --svg --output badges.svg
  oc-pilot sast --staged --fail-on-issue high
  oc-pilot authz --staged
  oc-pilot deps --json
  oc-pilot ecosystem-verify --staged --fail-on-issue high
  oc-pilot preflight --staged
  oc-pilot receipt --staged
  oc-pilot docgen "src/**/*.ts" --symbol buildPrompt
  git diff | oc-pilot scan --stdin
  oc-pilot commit --apply
  oc-pilot custom "Найди гонки данных" --git-diff
  oc-pilot setup --all
  oc-pilot setup --client claude --http https://example.com/mcp --token "$OC_PILOT_MCP_TOKEN"
  oc-pilot doctor
  oc-pilot reviewers --base main --limit 5
  oc-pilot replay --as md -o pr-comment.md
  oc-pilot slop --since origin/main --max-delta 10
  oc-pilot review --engine openai --model deepseek-chat --base-url https://api.deepseek.com/v1
  oc-pilot mcp --cwd /path/to/project

Коды возврата:
  0 — успех
  1 — ошибка выполнения
  2 — ошибка аргументов
  3 — политика (--fail-on-secrets / --fail-on / --strict)
`;

async function main(argv: string[]): Promise<number> {
  const command = argv[0];

  if (!command || command === "--help" || command === "-h" || command === "help") {
    if (command === "help" && argv[1] && HANDLERS[argv[1]]) {
      return HANDLERS[argv[1]]!(["--help"]);
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
      hint: "Доступные команды: review, test-fix, test-gen, test-guard, flaky, mutate, sast, authz, fix, docgen, custom, scan, deps, ecosystem-verify, env-sync, mock-leak, coverage, pack, contract-drift, anti-regression, boundaries, test-plan, compliance, brag, battle, cleanup, arch-diff, roast, cinema, bounty, autopsy, echo, preflight, receipt, ready, commit, install-hook, restore, cache, stats, day, impact, explain, reviewers, replay, slop, setup, init.",
      exitCode: 2,
    });
  }

  return handler(argv.slice(1));
}

process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const pilot = toPilotError(error);
    log.error(pilot.message);
    if (pilot.hint) {
      for (const line of pilot.hint.split(/\r?\n/)) log.detail(line);
    }
    if (!(error instanceof PilotError) && process.env.OC_PILOT_DEBUG) {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    }
    process.exitCode = pilot.exitCode;
  });
