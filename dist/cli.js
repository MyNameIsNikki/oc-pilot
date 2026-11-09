#!/usr/bin/env node
import { runCache } from "./commands/cache.js";
import { runDay } from "./commands/day.js";
import { runDeps } from "./commands/deps.js";
import { runEcosystemVerify } from "./commands/ecosystem-verify.js";
import { runEnvSync } from "./commands/env-sync.js";
import { runMockLeak } from "./commands/mock-leak.js";
import { runCoverage } from "./commands/coverage.js";
import { runPack } from "./commands/pack.js";
import { runZoomSymbol } from "./commands/zoom-symbol.js";
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
import { runInvariants } from "./commands/invariants.js";
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
import { runFuzzCommand } from "./commands/fuzz.js";
import { runBankruptcy } from "./commands/bankruptcy.js";
import { runQuery } from "./commands/query.js";
import { runSandboxCommand } from "./commands/sandbox.js";
import { runHivemind } from "./commands/hivemind.js";
import { runHoneypot } from "./commands/honeypot.js";
import { runAlienDna } from "./commands/alien-dna.js";
import { runHyperChamberCommand } from "./commands/hyper-chamber.js";
import { runButterflyCommand } from "./commands/butterfly.js";
import { runBlindfold } from "./commands/blindfold.js";
import { runSkepticCommand } from "./commands/skeptic.js";
import { runAntibody } from "./commands/antibody.js";
import { runPolygraph } from "./commands/polygraph.js";
import { runPassport } from "./commands/passport.js";
import { runOracleCommand } from "./commands/oracle.js";
import { runVaccine } from "./commands/vaccine.js";
import { runMitosis } from "./commands/mitosis.js";
import { runIntent } from "./commands/intent.js";
import { runScalpel } from "./commands/scalpel.js";
import { runMayday } from "./commands/mayday.js";
import { runClairvoyant } from "./commands/clairvoyant.js";
import { runHemorrhageCommand } from "./commands/hemorrhage.js";
import { runApoptosis } from "./commands/apoptosis.js";
import { runInjection } from "./commands/injection.js";
import { runSast } from "./commands/sast.js";
import { runAuthz } from "./commands/authz.js";
import { PilotError, toPilotError } from "./core/errors.js";
import { log } from "./core/log.js";
import { COMMON_HELP } from "./core/options.js";
import { runMcp } from "./mcp.js";
import { VERSION } from "./version.js";
const HANDLERS = {
    review: runReview,
    reviewers: runReviewers,
    "test-fix": runTestFix,
    "test-gen": runTestGen,
    "test-guard": runTestGuard,
    flaky: runFlaky,
    mutate: runMutate,
    fuzz: runFuzzCommand,
    bankruptcy: runBankruptcy,
    query: runQuery,
    sandbox: runSandboxCommand,
    hivemind: runHivemind,
    honeypot: runHoneypot,
    "alien-dna": runAlienDna,
    "hyper-chamber": runHyperChamberCommand,
    butterfly: runButterflyCommand,
    blindfold: runBlindfold,
    skeptic: runSkepticCommand,
    antibody: runAntibody,
    polygraph: runPolygraph,
    passport: runPassport,
    oracle: runOracleCommand,
    vaccine: runVaccine,
    mitosis: runMitosis,
    intent: runIntent,
    scalpel: runScalpel,
    mayday: runMayday,
    clairvoyant: runClairvoyant,
    hemorrhage: runHemorrhageCommand,
    apoptosis: runApoptosis,
    injection: runInjection,
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
    "zoom-symbol": runZoomSymbol,
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
    invariants: runInvariants,
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
  fuzz        Безопасный JIT-фаззинг экспортов из diff
  bankruptcy  Детерминированный прогноз техдолга и дата банкротства
  query       Графовый AQL-запрос к коду: find, where, select, count
  sandbox     Запуск JS/ESM в node:vm с заглушками и таймаутом
  hivemind    P2P-сеть агентов: ed25519, ECDH и шифрованный TCP
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
  zoom-symbol Достать полное тело одного символа из файла
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
  invariants  Смысловые инварианты проекта против diff
  preflight   Офлайн-проверка изменения: секреты, зависимости, тесты, slop
  honeypot    Приманки для агентов: deploy, status, remove
  alien-dna   Проверка архитектурной ДНК: паттерны diff против HEAD
  hyper-chamber  Симуляция года работы и поиск утечек памяти
  butterfly    Локальный chaos engineering для тестов: 500, задержки, битый JSON
  blindfold    Обезличить код и допросить модель на скрытые уязвимости
  skeptic      Проверить diff исполняемым тестом: clean, bug или unfalsifiable
  antibody     Учить SAST-находки и ловить их повторное появление в diff
  polygraph    Проверить утверждения коммита или PR против реального diff
  passport     Манифест происхождения: коммит, файлы, агент, модель и проверки
  oracle       Сравнить поведение HEAD и diff на одном корпусе входов
  vaccine      Превратить исправленный баг в регрессионный тест-вакцину
  mitosis      Разбить большой diff на маленькие проверяемые коммиты
  intent       Проверить критерии приёмки против diff и допросить требования
  scalpel      Минимальный патч под падающий тест и blast radius изменений
  mayday       Найти первый плохой коммит и подготовить безопасный откат
  clairvoyant  Предсказать затронутые тесты и минимальный набор для CI
  hemorrhage   Доказать регрессию производительности на бенчмарке
  apoptosis   Найти сенесцентные функции по @lifespan и удалить их после тестов
  injection   Поиск prompt-injection и скрытых инструкций в тексте для агента
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
  oc-pilot fuzz --duration 2s --memory-limit 128MB
  oc-pilot bankruptcy --history 30d --format json
  oc-pilot query "find(CallExpression).where(name, 'stripe').select(file, line)"
  oc-pilot sandbox run scripts/demo.mjs --timeout 500ms
  oc-pilot hivemind init
  oc-pilot coverage --staged --coverage-file coverage/lcov.info --fail-under 80
  oc-pilot env-sync --staged --fail-on-missing
  oc-pilot mock-leak --staged --fail-on-leak high
  oc-pilot pack "fix the login redirect" --staged --budget 12000
  oc-pilot pack --hologram --max-tokens 30000 --output context.md
  oc-pilot zoom-symbol src/core/pack.ts buildPack
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
  oc-pilot invariants --staged --fail-on violation
  oc-pilot sast --staged --fail-on-issue high
  oc-pilot authz --staged
  oc-pilot deps --json
  oc-pilot ecosystem-verify --staged --fail-on-issue high
  oc-pilot preflight --staged
  oc-pilot honeypot deploy
  oc-pilot alien-dna --staged
  oc-pilot hyper-chamber run scripts/task.mjs
  oc-pilot butterfly --command "npm test"
  oc-pilot blindfold --file src/checkout.ts
  oc-pilot skeptic --staged
  oc-pilot antibody learn
  oc-pilot antibody scan --staged
  oc-pilot polygraph --commit HEAD
  oc-pilot passport write --commit HEAD --check preflight=pass
  oc-pilot oracle --command "node harness.mjs {input}" --input corpus.json --staged
  oc-pilot vaccine create --fix HEAD --context "что сломалось"
  oc-pilot mitosis plan --strategy type
  oc-pilot intent check --criteria docs/acceptance.md --staged
  oc-pilot scalpel --log test-failure.log --apply
  oc-pilot mayday bisect --good v1.2.0 --bad HEAD --command "npm test"
  oc-pilot clairvoyant --staged
  oc-pilot hemorrhage --command "node bench.mjs" --runs 10
  oc-pilot apoptosis scan --fail-on-senescent
  oc-pilot injection --fail-on medium
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
            hint: "Доступные команды: review, test-fix, test-gen, test-guard, flaky, mutate, fuzz, bankruptcy, query, sandbox, hivemind, sast, authz, fix, docgen, custom, scan, deps, ecosystem-verify, env-sync, mock-leak, coverage, pack, zoom-symbol, contract-drift, anti-regression, boundaries, test-plan, compliance, brag, battle, cleanup, arch-diff, roast, cinema, bounty, autopsy, echo, invariants, preflight, honeypot, alien-dna, hyper-chamber, butterfly, blindfold, skeptic, antibody, polygraph, passport, oracle, vaccine, mitosis, intent, scalpel, mayday, clairvoyant, hemorrhage, apoptosis, injection, receipt, ready, commit, install-hook, restore, cache, stats, day, impact, explain, reviewers, replay, slop, setup, init.",
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