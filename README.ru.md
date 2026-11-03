# oc-pilot

[English version](README.md)

AI-ассистент разработчика для терминала: ревью git-diff, разбор падающих тестов, генерация документации и офлайн-поиск секретов. Работает поверх [OpenCode](https://opencode.ai) CLI или любого OpenAI-совместимого API, читает файлы проекта только для контекста и не меняет их. Доступен как MCP-сервер `oc-pilot-mcp` для Claude Code, Codex, Cursor, Gemini CLI, DeepSeek Harness и OpenCode.

```
oc-pilot review          # баги, уязвимости, идиомы языка
oc-pilot test-fix        # первопричина падения тестов + минимальный фикс
oc-pilot docgen src/**   # GoDoc / RustDoc / JSDoc / docstrings
oc-pilot scan            # секреты в diff без вызова модели
```

## Требования

- Node.js **22+**
- OpenCode CLI **2.x** в `PATH` (`opencode --version`) для движка по умолчанию **или** OpenAI-совместимый endpoint и ключ
- Настроенная модель и авторизация выбранного движка
- Для MCP-режима — любой агент с поддержкой MCP (Claude Code, Codex, Cursor, Gemini CLI, DeepSeek Harness, OpenCode)

## Установка

Из GitHub, с фиксацией на теге релиза (работает до первого релиза в npm):

```bash
npm install -g https://github.com/MyNameIsNikki/oc-pilot/archive/refs/tags/v0.5.2.tar.gz
```

Из npm, после публикации:

```bash
npm install -g oc-pilot
```

Для разработки:

```bash
git clone https://github.com/MyNameIsNikki/oc-pilot.git
cd oc-pilot
npm install
npm run build
npm install -g .
```

Для разработки без глобальной установки:

```bash
npm link
oc-pilot --version
```

## Быстрый старт

```bash
cd /path/to/your-project

oc-pilot setup                # настроить все найденные MCP-клиенты
oc-pilot doctor               # проверить установку, движок, ключи, git и MCP
oc-pilot scan                 # офлайн-проверка секретов
oc-pilot review               # diff HEAD (staged + unstaged)
oc-pilot review --staged
oc-pilot review --base main
git diff | oc-pilot review --stdin

# Без OpenCode:
export OC_PILOT_API_KEY="..."
oc-pilot review --engine openai --model deepseek-chat

oc-pilot test-fix             # разобрать падающий тест
oc-pilot fix --apply --command "npm test"  # патч + тесты
```

`review` только предлагает изменения: он не применяет патчи и не редактирует файлы. Писать в рабочее дерево умеет только `fix --apply`.

## Как это работает

1. `oc-pilot` собирает diff: `git diff HEAD`, `--staged`, `--base <ref>`, файл или stdin.
2. Определяет язык по изменённым файлам и манифестам проекта.
3. Сканирует **добавленные строки** на секреты и заменяет найденные значения маркерами `[REDACTED:<kind>]`.
4. Движок `opencode` (по умолчанию) запускает `opencode run --format json` и передаёт входные данные через stdin. Движок `openai` вызывает `/chat/completions` любого совместимого API и не требует OpenCode.
5. Встроенный агент OpenCode `oc-pilot` получает настоящий system prompt через `OPENCODE_CONFIG_CONTENT` и `--standalone`. В режиме по умолчанию ему разрешены только `read`, `glob`, `grep`; `edit`, `shell`, `webfetch`, `external_directory` и доступ к `.env`/ключам запрещены. Модель может проверить сигнатуры и вызовы в репозитории, но не изменить файлы.
6. С флагом `--no-repo-context` или движком `openai` создаётся изолированный контекст без инструментов. В промпт дополнительно попадает `FULL_FILE_CONTEXT` — полные изменённые файлы (до 60 000 символов, секреты редактируются), поэтому модель видит контекст функции без доступа к репозиторию.
7. Ответ печатается в stdout как Markdown; диагностика и предупреждения идут в stderr. `--fail-on` превращает найденные замечания в exit code 3 для CI.

Системные промпты лежат в [`prompts/oc-pilot.en.md`](prompts/oc-pilot.en.md), [`prompts/oc-pilot.ru.md`](prompts/oc-pilot.ru.md) и в [`src/core/prompt.ts`](src/core/prompt.ts). Готовая конфигурация агента для OpenCode — [`.opencode/agents/oc-pilot.md`](.opencode/agents/oc-pilot.md).

### Свой агент

По умолчанию используется встроенный `oc-pilot`. Флаг `--agent <name>` переключает на любой существующий агент OpenCode; в этом режиме системный промпт передаётся в сообщении пользователя, а права и инструменты определяются выбранным агентом. Это расширенный режим: провайдер может отфильтровать большой промпт как попытку инъекции, а `--no-repo-context` не сможет отозвать права чужого агента.

## Движки

`opencode` (по умолчанию) даёт лучшее ревью: агент читает вызовы и контракты в репозитории. `openai` убирает зависимость от OpenCode и работает с OpenAI, DeepSeek, Groq, OpenRouter, Ollama и любым совместимым endpoint; полные изменённые файлы передаются в промпт автоматически.

```bash
# OpenCode, read-only контекст репозитория
oc-pilot review

# Любой OpenAI-совместимый API
export OC_PILOT_API_KEY="..."
oc-pilot review --engine openai --model deepseek-chat \
  --base-url https://api.deepseek.com/v1

# Локальная модель через Ollama (ключ для localhost не нужен)
oc-pilot review --engine openai --model qwen2.5-coder \
  --base-url http://127.0.0.1:11434/v1
```

Ключ читается из `OC_PILOT_API_KEY` или `OPENAI_API_KEY`; переменную можно переименовать через `--api-key-env` / `apiKeyEnv`. Ключ не попадает в логи и ошибки.

### Умный slicing (`openai`)

Когда diff не помещается в один промпт (300 000 символов), движок `openai` не отбрасывает файлы усечением. Вместо этого блоки diff по файлам группируются в слайсы, каждый укладывается в бюджет; на каждый слайс делается отдельный вызов API с тем же дополнительным контекстом, ответы склеиваются в один анализ по OUTPUT SCHEMA (количество вызовов видно в `meta.slices`). До трёх слайсов уходят параллельно, ответы собираются в исходном порядке файлов. Файл, чей diff больше бюджета, уходит отдельным слайсом и усекается только тогда. Slicing работает для `review`, `test-fix`, `custom` и `commit --engine openai`; `fix` всегда шлёт один промпт, потому что должен вернуть единый патч.

### Повторы запросов

Временные сбои не валят прогон: ответы 408, 425, 429, 500, 502, 503 и 504 повторяются до трёх раз с экспоненциальной задержкой (500 мс, 1 с, 2 с, потолок 8 с), заголовок `Retry-After` важнее расчётной задержки. Ошибки аутентификации, прочие 4xx, сетевые ошибки и таймауты падают сразу — повторять их бессмысленно. Слайсы подчиняются тому же правилу.

### Двухфазный роутинг (`openai`)

`review` может прогонять diff через дешёвую модель-триаж до основного вызова. Модель триажа получает те же данные с компактным системным промптом и отвечает одной строкой: `TRIAGE: REVIEW` или `TRIAGE: LGTM`. Тривиально безопасные изменения (доки, форматирование, бампы версий, переименования) получают `LGTM` — основной вызов пропускается целиком; остальное идёт в полный ревью. Любая ошибка или нечитаемый ответ триажа откатывается к полному ревью: роутинг экономит деньги, но не способен пропустить проблему. Блокировка по секретам (`--fail-on-secrets`) работает независимо от роутера.

```bash
oc-pilot review --router --router-model gpt-4.1-mini --engine openai --model gpt-4.1
```

Включается на один запуск флагом `--router` или постоянно — полями `routerEnabled: true` и `routerModel` в `.oc-pilot.json` (или переменными `OC_PILOT_ROUTER` / `OC_PILOT_ROUTER_MODEL`). `--no-router` отключает роутинг на один запуск. В JSON-отчёте появляется `meta.router` с моделью, решением и длительностью.

### Cache-friendly промпты

oc-pilot собирает каждый промпт так, чтобы стабильные части шли первыми, а изменчивый `GIT_DIFF` — последним: инструкция, тип проекта, рецепт, флаги репозитория, контекст и отчёт сканера секретов одинаковы между слайсами, раундами fix и повторными ревью одного изменения. Провайдеры с префикс-кэшированием (OpenAI, DeepSeek, Anthropic, OpenRouter) переиспользуют стабильный префикс автоматически — второй и последующие вызовы на том же контексте дешевле и быстрее. Настройка не требуется.

### Кеш ответов (`openai`)

Движок `openai` кеширует полные ответы модели на диске. Ключ кеша — sha256 от модели, base URL, системного промпта и входа, поэтому повторный запуск той же команды на том же diff (типично при настройке хуков, CI и скриптов) не тратит ни одного токена и возвращается мгновенно. Записи лежат в `.git/oc-pilot/cache/` — внутри метаданных репозитория, они не попадают в рабочее дерево и в коммиты.

TTL по умолчанию 24 часа (`cacheTtlSeconds`, или `OC_PILOT_CACHE_TTL`; `0` отключает кеш). `--no-cache` обходит кеш на один запуск, `oc-pilot cache --stats | --prune | --clear` показывает и обслуживает его, `doctor --fix` вычищает просроченные записи. В JSON-отчёте видно `meta.cache: "hit" | "miss"`. Кеш работает только для движка `openai` (триаж, основной вызов и слайсы); запуски через OpenCode не кешируются, а ошибка кеша никогда не ломает ревью.

### Second opinion (`openai`)

`review --second-opinion` перед финальным вердиктом прогоняет до 10 критичных находок через вторую, скептическую модель. Ответ — одна строка: `VERDICT: CONFIRM` подтверждает находку, `VERDICT: REJECT — <причина>` понижает её до style и помечает буллет `[second opinion: rejected — причина]`. Если верификатор недоступен или ошибся, находки остаются как есть — ошибка проверки никогда не ослабляет ревью. Верификатор настраивается флагами `--second-opinion-model` / `--second-opinion-base-url` / `--second-opinion-api-key-env` или ключами конфига `secondOpinionEnabled`, `secondOpinionModel`, `secondOpinionBaseUrl`, `secondOpinionApiKeyEnv`; итог — в `meta.secondOpinion`.

### Лимиты и статистика

Каждый запуск и вызов API записывается в `.git/oc-pilot/stats.jsonl` (находки, движок, код возврата, попадания кеша). `oc-pilot stats` выводит запуски, вызовы API, попадания кеша и находки за сегодня, неделю и всё время (`--clear` сбрасывает). Дневной бюджет вызовов задаётся `maxDailyApiCalls` или `OC_PILOT_MAX_DAILY_API_CALLS` (`0` — без лимита); при исчерпании команда выходит с кодом 1 — попадания кеша лимит не расходуют. `oc-pilot day --since "1 day ago"` — сводка того, что натворил агент: коммиты, churn по файлам, строки +/- и находки oc-pilot.

### Правила агента

Если в проекте есть `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules` или `.github/copilot-instructions.md`, oc-pilot включает его в каждый промпт (первый найденный, до 10 000 символов, секреты маскируются) — ревьюер знает те же договорённости, что и кодинг-агент. Отключается `agentRules: false` в конфиге или `OC_PILOT_AGENT_RULES=0`.

## Команды

### `review`

```bash
oc-pilot review [пути...] [опции]
```

| Опция | Назначение |
| --- | --- |
| `--staged` | только staged-изменения |
| `--unstaged` | только unstaged-изменения |
| `--base <ref>` | diff `<ref>...HEAD` для PR |
| `--diff <file\|->` | готовый diff из файла или stdin |
| `--stdin` | читать diff из stdin |
| `--include-untracked` | добавить новые файлы (до 200) |
| `--context <text\|@file>` | дополнительный контекст |
| `--lang <en\|ru>` | язык системного промпта и ответа (по умолчанию `en`) |
| `--engine <opencode\|openai>` | движок модели (по умолчанию `opencode`) |
| `--base-url <url>` | OpenAI-совместимый endpoint |
| `--api-key-env <name>` | переменная с API-ключом (по умолчанию `OC_PILOT_API_KEY`) |
| `--no-repo-context` | не давать агенту читать файлы (только diff) |
| `--rules <path>` | файл правил проекта |
| `--fail-on <level>` | exit 3 при замечаниях `critical`, `warning` или `style` |
| `--fail-on-secrets` | exit 3 при critical-секретах |
| `--no-secret-scan` | не искать секреты и не редактировать diff |
| `--router` | двухфазный роутинг: дешёвый триаж перед ревью (`openai`) |
| `--no-router` | отключить роутинг, включённый в конфиге |
| `--router-model <m>` | модель триажа (по умолчанию `routerModel` из конфига) |
| `--baseline` | скрыть находки из `.oc-pilot/baseline.json` |
| `--update-baseline` | перезаписать baseline текущими находками и выйти |
| `--pr` | отправить inline-комментарии к строкам PR (Actions REST или `gh`) |
| `--no-pr-inline` | отправить один сводный комментарий вместо inline |
| `--pr-status` | выставить блокирующий commit status (`failure` при critical) |
| `--second-opinion` | проверить критичные находки второй моделью (`openai`) |
| `--second-opinion-model <m>` | модель-верификатор (по умолчанию `secondOpinionModel` или основная) |
| `--require-tests` | код 3, если логика изменена без тестов |
| `--no-test-weakening` | код 3, если тесты ослаблены (skip, удалённые проверки) |
| `--interactive` | по каждой находке спросить, не скрыть ли её в baseline (TTY) |

С `--baseline` находки, уже записанные в `.oc-pilot/baseline.json`, скрываются из вывода и не влияют на код возврата, JSON, SARIF и PR-комментарий — блокируют только новые. Отпечаток находки — `severity | файл | нормализованный текст`, без номера строки, поэтому известные находки переживают сдвиги кода. `--update-baseline` перезаписывает файл по текущему ревью и выходит с кодом 0; `--interactive` прячет находки по одной и дописывает их в baseline. `--pr` отправляет ревью в текущий PR: внутри GitHub Actions — через review API с `GITHUB_TOKEN`, до 25 находок прикрепляются inline-комментариями к своим строкам диффа (нужна permission `pull-requests: write`); находки вне изменённых строк и любой запуск вне Actions откатываются на один сводный комментарий (локально — через `gh pr comment`, нужен установленный и авторизованный `gh`). `--no-pr-inline` принудительно оставляет только сводный комментарий. `--pr-status` выставляет commit status в контексте `oc-pilot` — `failure`, пока остаются critical-находки, иначе `success` — чтобы правило защиты ветки могло его требовать (нужна `statuses: write`). Работает и в текстовом, и в SARIF-режиме.

До вызова модели `review` сам осматривает diff: новые зависимости проверяются на тайпосквоты, незакреплённые версии и VCS/URL-спеки в манифестах npm, PyPI, Go, Cargo, RubyGems, Packagist, Maven/Gradle и NuGet (подсказка `DEPENDENCY_CHANGES`, `meta.dependencies`); крупное изменение логики (20+ добавленных строк кода) без тестов даёт `TEST_COVERAGE_HINT` (`--require-tests` превращает в код 3, `meta.testDelta`); ослабленные тесты дают `TEST_WEAKENING` (пропущенные и сфокусированные тесты, удалённые проверки без замены, закомментированные ассерты, поднятые таймауты; `--no-test-weakening` превращает в код 3, `meta.testWeakening`); добавленные строки с признаками prompt injection (переопределение инструкций, role-hijack, эксфильтрация промпта, base64-блобы, невидимый Unicode) дают предупреждение `PROMPT_INJECTION_RISKS` (`meta.injection`).

### `test-fix`

```bash
oc-pilot test-fix
oc-pilot test-fix --command "go test ./..."
oc-pilot test-fix --log failures.log
oc-pilot test-fix --log - --exit-code 1
```

Команда тестов определяется автоматически по `package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`, `pom.xml`, Gradle, `Package.swift`, `mix.exs`, `pubspec.yaml`, `Gemfile`, `composer.json`, `*.csproj` или `Makefile`. Если определить не удалось — укажите `--command` или `testCommand` в конфиге.

`test-fix` прикладывает diff (если это git-репозиторий), выдержки из файлов, найденных в стеке, и последние строки вывода. Успешный прогон не анализируется, если не передан `--force`.

### `fix`

Просит модель вернуть unified diff, проверяет его через `git apply --check` и с `--apply` применяет в рабочем дереве. Это единственная команда, которая меняет файлы.

```bash
oc-pilot fix --diff changes.diff                 # только показать патч
oc-pilot fix --apply --command "npm test"        # применить и проверить
oc-pilot fix --apply --command "go test ./..." --keep-on-test-failure
oc-pilot review --github                         # аннотации GitHub Actions
```

| Опция | Назначение |
| --- | --- |
| `--apply` | применить патч к рабочему дереву |
| `--command <cmd>` | тесты после применения; иначе `testCommand` или автоопределение |
| `--no-tests` | применить без запуска тестов |
| `--keep-on-test-failure` | не откатывать патч при падении тестов |
| `--no-snapshot` | не создавать снимок перед применением |

`fix` не делает commit и push. При падении тестов патч откатывается, если не указан `--keep-on-test-failure`. Чужие незакоммиченные изменения не откатываются.

Перед применением `fix` сохраняет снимок рабочего дерева в `.git/oc-pilot/snapshots/` (tracked-изменения бинарным патчем + копии untracked-файлов). Снимки локальны: они не попадают в коммиты. Откат — `oc-pilot restore`; отключить снимок — `--no-snapshot`.

### `docgen`

```bash
oc-pilot docgen src/core/prompt.ts
oc-pilot docgen "src/**/*.ts" --symbol buildPrompt
oc-pilot docgen internal/wallet --context "GoDoc, без markdown"
```

Поддерживаются файлы, директории и маски (`*`, `**`, `?`). Скрытые и служебные директории (`node_modules`, `dist`, `target`, `.git` и т.п.) пропускаются. Команда возвращает документацию в ответе; файлы не перезаписываются. Ограничения: `--max-file` (60k символов на файл), `--max-diff` (общий бюджет контекста).

### `custom`

```bash
oc-pilot custom "Предложи, как разбить этот модуль" --git-diff
oc-pilot custom "Найди гонки данных" --diff changes.patch
oc-pilot custom "Объясни архитектуру" --context @ARCHITECTURE.md
```

Свободный запрос с необязательным diff (`--git-diff`, `--diff`, `--stdin`, `--staged`, `--base`).

## Правила проекта

Создайте `.oc-pilot/rules.md` в корне проекта (или укажите путь через `--rules` / `rules` в конфиге). Файл автоматически ищется вверх по дереву и добавляется в каждый запрос как `PROJECT_RULES`:

```markdown
# Правила ревью

- Все ошибки оборачивать через `fmt.Errorf("...: %w", err)`.
- Не логировать PII и токены.
- Для новых публичных функций обязателен GoDoc.
- Не предлагать новые зависимости без явного запроса.
```

Правила тоже сканируются на секреты и редактируются. Лимит — 20 000 символов. Это не заменяет `AGENTS.md`: OpenCode загружает его сам, а `PROJECT_RULES` гарантированно попадает в промпт oc-pilot.

### `scan`

Офлайн-сканер секретов, модель не вызывается.

```bash
oc-pilot scan
oc-pilot scan --staged --strict
oc-pilot scan --all
git diff main...HEAD | oc-pilot scan --stdin --json

# SARIF 2.1.0 для GitHub Code Scanning
oc-pilot scan --staged --format sarif -o oc-pilot.sarif
```

Код возврата `1` при critical-находках (или при любых с `--strict`), `0` — чисто, `--no-fail` — всегда `0`. `--format sarif` пишет отчёт SARIF 2.1.0 (правила `oc-pilot/secret`, `oc-pilot/critical`, `oc-pilot/warning`), который загружается в GitHub Code Scanning; превью секретов остаются замаскированными.

`--all` сканирует всё дерево, а не diff: учитываются `.gitignore` и `.oc-pilot/ignore`, пропускаются бинарники, `node_modules`, `dist` и файлы больше 512 КБ, в отчёте есть число проверенных файлов (`meta.filesScanned`).

### `commit`

Генерирует commit-сообщение в формате Conventional Commits по staged-изменениям и опционально коммитит. Модель видит последние 10 commit-сообщений проекта и подстраивается под их стиль.

```bash
oc-pilot commit               # вывести сообщение
oc-pilot commit --apply       # закоммитить staged с готовым сообщением
oc-pilot commit --json        # машиночитаемый вывод
```

`--apply` работает только со staged и блокируется (код `3`) при critical-секретах в diff; `--allow-secrets` снимает блокировку. С `--engine openai` большой diff разбивается на слайсы (см. «Движки»), сообщение покрывает все файлы.

### `install-hook`

Ставит нативные git-хуки без husky и зависимостей. Хук `pre-commit` запускает `oc-pilot scan --staged`; с `--pre-push` дополнительно ставится `pre-push` с `oc-pilot review --fail-on critical --fail-on-secrets`.

```bash
oc-pilot install-hook
oc-pilot install-hook --pre-push
oc-pilot install-hook --uninstall
```

Хуки опциональны и обратимы. Чужой хук не перезаписывается без `--force`, а при замене сохраняется как `<hook>.oc-pilot.bak`. Обход на одну команду — `OC_PILOT_SKIP=1`. Поддерживаются `core.hooksPath` и worktrees.

### `restore`

Восстанавливает рабочее дерево из последнего снимка, сделанного перед `fix --apply`.

```bash
oc-pilot restore          # последний снимок
oc-pilot restore --list   # список снимков
oc-pilot restore <id>     # конкретный снимок
```

Снимки хранятся в `.git/oc-pilot/snapshots/` и не попадают в коммиты. Восстановление отказывается работать, если HEAD ушёл вперёд после снимка, чтобы не потерять закоммиченную работу. Разделение staged/unstaged не восстанавливается; untracked-файлы, созданные после снимка, не удаляются.

### `cache`

Показывает и обслуживает кеш ответов движка `openai` в `.git/oc-pilot/cache/`.

```bash
oc-pilot cache            # записи, размер, просрочено
oc-pilot cache --prune    # удалить просроченные записи
oc-pilot cache --clear    # удалить всё
```

Кеш работает только внутри git-репозитория и только для движка `openai`.

### `stats`

Статистика использования из `.git/oc-pilot/stats.jsonl`: запуски, вызовы API, попадания кеша, средняя длительность вызова и находки (critical/warning/style) за сегодня, 7 дней и всё время.

```bash
oc-pilot stats
oc-pilot stats --json
oc-pilot stats --clear
```

### `day`

Локальный дайджест активности: что закоммичено с заданного момента, какие файлы больше всего менялись, строки +/- и находки oc-pilot за период.

```bash
oc-pilot day
oc-pilot day --since "3 days ago" --json
```

### `impact`

Показывает, где ещё используются изменённые символы. Из diff извлекаются объявления функций, методов, классов, типов и интерфейсов — и из добавленных, и из удалённых строк, поэтому переименование видно под обоими именами, — затем по ним ищутся вхождения в tracked и untracked файлах. Это текстовый поиск, а не AST, поэтому возможны лишние совпадения; команда никогда не валит сборку.

```bash
oc-pilot impact
oc-pilot impact --staged --json
```

`--json` отдаёт `symbols`, `references`, `scannedFiles` и `touchedFiles` — ровно то, что нужно агенту, чтобы понять, что ещё может сломаться от изменения.

### `setup`

Настраивает MCP-клиент на запуск `oc-pilot-mcp`, сохраняя чужие серверы и настройки. По умолчанию используется текущая установка (`node dist/mcp.js`); `--npx` записывает `npx -y oc-pilot@<version> mcp`, `--local` принудительно выбирает локальный путь. Сгенерированный сервер read-only; `--allow-write` разрешает агенту применять патчи и запускать тесты.

```bash
oc-pilot setup                # все найденные клиенты
oc-pilot setup --client claude --local
oc-pilot setup --client opencode --client cursor --local
oc-pilot setup --client codex --global
oc-pilot setup --client claude --local --print
oc-pilot setup --client claude --local \
  --http https://oc-pilot.example.com/mcp --token "$OC_PILOT_MCP_TOKEN"
```

Клиенты: `claude`, `codex`, `cursor`, `gemini`, `opencode`, `vscode`, `windsurf`, `zcode`, `agents`. Без `--client` `setup` сам находит установленные клиенты по командам и каталогам конфигов. Опции: `--all`, `--client` (повторяемый), `--global` (иначе проект), `--local` (абсолютный путь текущей установки), `--npx` (команда `npx` с закреплённой версией), `--allow-write`, `--print`, `--json`, `--http`, `--token`, `--cwd`, `--force`. `setup` меняет только конфиг MCP-клиента и не устанавливает пакеты. Bearer-токен не записывается в конфиг: клиент читает его из `OC_PILOT_MCP_TOKEN`.

### `doctor`

Проверяет установку и объясняет, что мешает работе:

```bash
oc-pilot doctor
oc-pilot doctor --json
oc-pilot doctor --engine openai --model deepseek-chat
oc-pilot doctor --fix
```

Проверки: Node, движок, ключ API, git и репозиторий, тестовая команда, правила проекта, git-хуки oc-pilot и кеш ответов, конфиги MCP-клиентов. `--fix` обновляет устаревшие хуки oc-pilot (предыдущий файл сохраняется как бэкап) и вычищает просроченные записи кеша; чужие хуки не трогаются — о них сообщается. Ошибки дают exit 1; `--strict` также падает на предупреждениях. Секреты не печатаются.

### `init`

```bash
oc-pilot init
oc-pilot init --force
oc-pilot init --preset node
```

Создаёт `.oc-pilot.json` с настройками по умолчанию. С `--preset <a,b>` дополнительно пишет готовый `.oc-pilot/rules.md` под стек. Пресеты можно комбинировать, например `--preset react,security`:

`base` (универсальный), `node`, `react`, `next`, `vue`, `svelte`, `angular`, `typescript`, `python`, `go`, `rust`, `java`, `kotlin`, `csharp`, `swift`, `php`, `ruby`, `flutter`, `elixir`, `zig`, `scala`, `security` (сквозная безопасность), `devops` (Docker, CI, инфраструктура).

Это обычный файл правил — дополняйте его свободно.

## Конфигурация

`oc-pilot` ищет `.oc-pilot.json` в текущей директории и выше (до 32 уровней). Приоритет: **CLI > переменные окружения > файл > значения по умолчанию**.

```json
{
  "engine": "opencode",
  "agent": "oc-pilot",
  "model": "anthropic/claude-sonnet-4-5",
  "maxDiffChars": 120000,
  "maxOutputChars": 40000,
  "maxFileChars": 60000,
  "timeoutSeconds": 300,
  "testCommand": "npm test",
  "redactSecrets": true,
  "repoContext": true,
  "failOn": "none",
  "agentRules": true,
  "secondOpinionEnabled": false,
  "maxDailyApiCalls": 0
}
```

| Поле | По умолчанию | Описание |
| --- | --- | --- |
| `agent` | `oc-pilot` | агент OpenCode |
| `model` | модель OpenCode | `provider/model#variant` |
| `maxDiffChars` | `120000` | лимит diff |
| `maxOutputChars` | `40000` | лимит вывода тестов |
| `maxFileChars` | `60000` | лимит одного файла для `docgen` |
| `timeoutSeconds` | `300` | таймаут тестов и запроса |
| `testCommand` | авто | команда для `test-fix` |
| `redactSecrets` | `true` | заменять секреты маркерами |
| `repoContext` | `true` | read-only доступ агента к файлам проекта |
| `failOn` | `none` | exit 3 при замечаниях: `critical`, `warning`, `style`, `none` |
| `rules` | авто | путь к файлу правил (иначе `.oc-pilot/rules.md` вверх по дереву) |

Для API-движка: `"engine": "openai"`, `"model": "deepseek-chat"`, `"baseUrl": "https://api.deepseek.com/v1"` и при необходимости `"apiKeyEnv": "DEEPSEEK_API_KEY"`.

Переменные окружения: `OC_PILOT_ENGINE`, `OC_PILOT_BASE_URL`, `OC_PILOT_API_KEY_ENV`, `OC_PILOT_MODEL`, `OC_PILOT_AGENT`, `OC_PILOT_MAX_DIFF_CHARS`, `OC_PILOT_MAX_OUTPUT_CHARS`, `OC_PILOT_MAX_FILE_CHARS`, `OC_PILOT_TIMEOUT_SECONDS`, `OC_PILOT_TEST_COMMAND`, `OC_PILOT_REDACT_SECRETS`, `OC_PILOT_REPO_CONTEXT`, `OC_PILOT_FAIL_ON`, `OC_PILOT_RULES`.

## Безопасность

- Сканер ищет AWS/GitHub/GitLab/Slack/Stripe/Google/OpenAI/Anthropic/npm/Hugging Face/Groq/Discord/SendGrid/DigitalOcean/PyPI/Azure-токены, Telegram-бот-токены, JWT, приватные ключи, credentials в URL, generic-присваивания (`password: "..."`) и `.env`-строки (`DB_PASSWORD=...`).
- Присваивания длиной от 20 символов с энтропией Шеннона выше 4 бит помечаются как critical `High-entropy secret`.
- Ложные срабатывания отключаются точечно: маски путей в `.oc-pilot/ignore` (по одной на строку, `#` — комментарий) или инлайн-маркер в конце строки кода:

```
# .oc-pilot/ignore
fixtures/**
docs/examples/**

# инлайн, любой язык
const TOKEN = "sk-proj-..."; // oc-pilot:ignore-secret
```

  Правила действуют по путям и строкам во всех точках сканирования (diff, правила, docgen, full-file контекст) и не отключают сканер для остального проекта.
- Проверяются только **добавленные** строки diff; удалённые и контекстные строки не считаются утечкой.
- Найденные значения заменяются маркерами до отправки модели. В отчётах показывается только маска вида `AKIA…MPLE`.
- Блок приватного ключа редактируется целиком, включая тело.
- `--no-secret-scan` и `redactSecrets: false` отключают защиту: секреты из diff, `PROJECT_RULES` и `FULL_FILE_CONTEXT` могут уйти провайдеру модели.
- Сканер — быстрый эвристический слой, а не замена gitleaks/detect-secrets. Для CI используйте специализированный сканер и ротацию ключей.
- Вывод тестов и произвольный `--context` не проходят redaction; не передавайте туда секреты. `PROJECT_RULES` сканируется и редактируется.
- В режиме `repoContext` агенту разрешены только `read`, `glob`, `grep`. Запрещены `edit`, `shell`, `subagent`, `webfetch`, `websearch`, `external_directory`, чтение `.env`, приватных ключей, `.ssh`, `.aws`, `.git` и типичных credential-файлов. Это ограничение задаётся permissions OpenCode и не является sandbox уровня ОС.
- Проект может содержать собственные `opencode.json`/плагины/`AGENTS.md`; `--standalone` загружает их. Для недоверенного репозитория используйте `--no-repo-context`.

## Вывод

- Текстовый режим — Markdown в stdout, служебные сообщения в stderr.
- `--json` — объект:

```json
{
  "recipe": "review",
  "projectType": "Go",
  "analysis": "### Анализ: ...",
  "findings": [
    { "severity": "critical", "location": "wallet.go:10", "text": "nil pointer dereference" }
  ],
  "secrets": [
    { "file": "wallet.go", "line": 14, "kind": "OpenAI API key", "severity": "critical", "preview": "sk-p…ABCD" }
  ],
  "meta": {
    "agent": "oc-pilot",
    "model": null,
    "durationMs": 12345,
    "filesChanged": 1,
    "formatValid": true,
    "formatWarnings": [],
    "repoContext": true,
    "rules": ".oc-pilot/rules.md",
    "findings": { "critical": 1, "warning": 0, "style": 0 }
  }
}
```

`findings` парсятся из секции `#### Замечания / Действия` (русский) или `#### Findings / Actions` (английский); `--fail-on <level>` использует их для exit code 3. JSON стабилен для CI, но текст `analysis` остаётся основным результатом.

`--dry-run` печатает системный промпт и входные данные, не вызывая модель. Удобно для отладки и CI-проверок.

## Коды возврата

| Код | Значение |
| --- | --- |
| `0` | успех |
| `1` | ошибка выполнения, сбой OpenCode или critical-секрет в `scan` |
| `2` | ошибка аргументов/конфигурации |
| `3` | нарушена политика: `--fail-on-secrets`, `--fail-on` или `--strict` |

## MCP-сервер

`oc-pilot-mcp` — MCP-сервер для Claude Code, Codex, Cursor, Gemini CLI, OpenCode, ZCode и любых клиентов с `.agents/mcp.json`. Он даёт агенту инструменты `review`, `test_fix`, `fix`, `docgen`, `custom`, `scan`, а модель и доступ к репозиторию остаются в вашем CLI.

Помимо инструментов сервер отдаёт read-only MCP-ресурсы: `oc-pilot://config` (итоговый конфиг), `oc-pilot://rules` (правила проекта с маскировкой секретов), `oc-pilot://prompt/en` и `oc-pilot://prompt/ru` (встроенные системные промпты), `oc-pilot://version`. Шаблоны ресурсов дают живые данные: `oc-pilot://diff/{mode}` (staged/unstaged/head diff, секреты замаскированы), `oc-pilot://scan/{mode}` (офлайн-поиск секретов в JSON) и `oc-pilot://file/{+path}` (любой файл проекта до 2 МБ с маскировкой найденных секретов). Клиенты получают списки через `resources/list` и `resources/templates/list`.

Автонастройка клиента:

```bash
oc-pilot setup --client claude --local
oc-pilot setup --client cursor --global
```

ZCode импортирует серверы из Claude Code, Codex, OpenCode и `.agents`, либо пишет нативный конфиг через `oc-pilot setup --client zcode`.

Запуск вручную:

```bash
oc-pilot-mcp --cwd "C:\path\to\project"
# после релиза в npm, версия зафиксирована:
npx -y oc-pilot@0.5.2 mcp --cwd "C:\path\to\project"
```

Пример для Claude Code (`.mcp.json`):

```json
{
  "mcpServers": {
    "oc-pilot": {
      "command": "oc-pilot-mcp",
      "args": ["--cwd", "."]
    }
  }
}
```

DeepSeek Harness (`dsh`) подключает сервер через `@deepseek-ai/dsh-mcp-client` в `~/.dsh/profiles/web/cordis.patch.yml`; готовый YAML для stdio и Streamable HTTP есть в [docs/integrations.md](docs/integrations.md#deepseek-harness). Для применения патчей добавьте `'--allow-write'` в `args`.

### Streamable HTTP и Docker

Для контейнеров и удалённых агентов:

```bash
oc-pilot-mcp --http --host 127.0.0.1 --port 8787 --path /mcp \
  --cwd /workspace --token "$OC_PILOT_MCP_TOKEN"
curl http://127.0.0.1:8787/health
```

Сервер возвращает `Mcp-Session-Id` при initialize; его нужно передавать в следующих запросах. При `--token` все запросы кроме `GET /health` требуют `Authorization: Bearer <token>`. Без токена длиной от 16 символов сервер не запустится на не-loopback хосте. Для публичного доступа ставьте TLS-прокси.

MCP по умолчанию **read-only** и для stdio, и для HTTP: `fix` с `apply:true` и `test_fix`, запускающий новую команду, отклоняются. Для доверенного локального клиента или аутентифицированного окружения добавьте `--allow-write` (в `setup` — `oc-pilot setup --allow-write`) или `OC_PILOT_MCP_READ_ONLY=false`.

```bash
export OC_PILOT_MCP_TOKEN="$(openssl rand -hex 24)"
docker build -t oc-pilot-mcp .
docker run --rm -p 8787:8787 \
  -e OC_PILOT_MCP_TOKEN="$OC_PILOT_MCP_TOKEN" \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -v "$PWD:/workspace" oc-pilot-mcp
```

Или `docker-compose up`. Образ включает OpenCode; `scan` работает без модели.

В `skills/` лежат переносимые Agent Skills для Claude Code, Codex, Cursor, Copilot и OpenCode. Каждый объясняет агенту, какой шлагбаум нужно закрыть, прежде чем считать работу готовой:

| Skill | Назначение |
| --- | --- |
| `oc-pilot` | Точка входа: когда вызывать `scan`, `review`, `test-fix`, `fix` и `docgen`. |
| `agent-self-review` | Цикл перед коммитом: скан, ревью, фикс, повторная проверка, отчёт с кодом возврата. |
| `test-failure-triage` | Захват лога падения, первопричина, патч со снимком, повторный прогон. |
| `secure-diff-gate` | Секреты, правила безопасности, признаки промпт-инъекций и риски зависимостей, SARIF. |
| `commit-discipline` | Conventional Commit по staged-diff с блокировкой при секретах. |
| `stack-review-packs` | Комбинируемые наборы правил для 23 стеков. |

Скопируйте нужный каталог в свой skills-каталог или укажите клиенту на этот репозиторий.

Конфигурации для Codex, Cursor, Gemini CLI и OpenCode, формат результата и CI-примеры — в [docs/integrations.md](docs/integrations.md). Инструменты принимают `diff` и `log` как текст, а `paths` — относительно `--cwd`.

## GitHub Action

В репозитории есть composite action: gate для pull request настраивается в три строки.

```yaml
name: review
on: [pull_request]
jobs:
  oc-pilot:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: MyNameIsNikki/oc-pilot@v0.13.0
        with:
          command: scan
          args: --base origin/${{ github.base_ref }} --fail-on-secrets
```

Входы: `command` (`scan`, `review`, `test-fix`, `docgen`, `custom`), `args`, `working-directory`, `annotations`, `version`. `scan` не требует API-ключа; для review задайте движок и переменные провайдера на шаге.

## CI

GitHub Actions:

```yaml
name: oc-pilot
on: pull_request
jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install -g opencode-ai
      - run: npm ci && npm run build
        working-directory: oc-pilot
      - run: node dist/cli.js scan --base "origin/${{ github.base_ref }}"
        working-directory: oc-pilot
      - run: node dist/cli.js review --base "origin/${{ github.base_ref }}" --fail-on warning --fail-on-secrets --github
        working-directory: oc-pilot
        env:
          OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}
```

`--github` печатает inline-аннотации `::error file=...,line=...` и `::warning`. Для машинного отчёта используйте `--json --output review.json`. Провайдер и переменные авторизации зависят от вашей конфигурации OpenCode. В CI заранее выполните `opencode auth` или передайте ключ провайдера через секреты.

Загрузка результатов в GitHub Code Scanning:

```yaml
      - run: node dist/cli.js scan --base "origin/${{ github.base_ref }}" --format sarif -o oc-pilot.sarif
        working-directory: oc-pilot
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: oc-pilot.sarif
```

## Ограничения

- Diff обрезается до `maxDiffChars`; при переполнении файлы усекаются, в diff появляется маркер.
- Untracked-файлы не попадают в diff без `--include-untracked`.
- `review`/`test-fix`/`docgen` не меняют файлы; применять патчи умеет только `fix --apply`. Патчи, затрагивающие файлы вне diff, отклоняются.
- `fix` лучше работает с текстовыми патчами; бинарные файлы, переименования и CRLF-репозитории могут потребовать ручного `git apply`.
- HTTP-сервер рассчитан на одного арендатора. По умолчанию он read-only; `--allow-write` разрешает `fix.apply` и запуск новых тестовых команд в смонтированном workspace.
- Автоопределение команды тестов может ошибаться в нестандартных проектах.
- `repoContext` запускает агента в проекте через `--standalone`, поэтому проектные `opencode.json`, плагины и `AGENTS.md` загружаются. Для недоверенного кода используйте `--no-repo-context`.
- Read-only права задаются permissions OpenCode, а не изоляцией ОС: не запускайте инструмент на коде, которому не доверяете.
- `--fail-on` извлекает замечания из Markdown-секции; при нестандартном ответе используйте `--strict`, чтобы поймать нарушение схемы.
- Правила проекта ограничены 20 000 символов и не заменяют `AGENTS.md`.
- Качество и стиль ответа зависят от выбранной модели; `--strict` проверяет только наличие заголовков OUTPUT SCHEMA.
- Данные diff отправляются выбранному провайдеру модели. Для приватного кода используйте локальную модель или прокси.

## Разработка

```bash
npm run check       # tsc --noEmit
npm test            # build + node:test
npm run prompt:export  # синхронизировать prompts/oc-pilot.en.md, prompts/oc-pilot.ru.md и .opencode/agents/oc-pilot.md
```

Структура:

```
src/
  cli.ts                 точка входа и help
  commands/              review, test-fix, docgen, custom, scan, init
  core/
    config.ts            .oc-pilot.json + env
    diff.ts              парсинг, статистика, обрезка diff
    diff-source.ts       git / файл / stdin
    file-context.ts      полные файлы для --no-repo-context
    findings.ts          парсинг замечаний и --fail-on
    git.ts               git diff, untracked
    rules.ts             .oc-pilot/rules.md
    secrets.ts           правила, redaction, отчёты
    prompt.ts            системный промпт и INPUT
    opencode.ts          запуск агента и парсинг JSON-событий
    snippets.ts          выдержки из стека тестов
    project.ts           язык и команда тестов
    run.ts               общий executor и политика
  mcp.ts                 MCP stdio-сервер (oc-pilot-mcp)
  mcp.test.ts            интеграционные тесты MCP
scripts/export-prompt.mjs
docs/integrations.md
prompts/oc-pilot.en.md
prompts/oc-pilot.ru.md
.opencode/agents/oc-pilot.md
README.md
README.ru.md
```

## Лицензия

MIT. См. [LICENSE](LICENSE).
