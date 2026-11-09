# oc-pilot: иммунная система для AI vibe coding

[![npm version](https://img.shields.io/npm/v/oc-pilot.svg)](https://www.npmjs.com/package/oc-pilot)
[![Node.js](https://img.shields.io/node/v/oc-pilot.svg)](https://nodejs.org/)
[![dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/MyNameIsNikki/oc-pilot/actions/workflows/ci.yml/badge.svg)](https://github.com/MyNameIsNikki/oc-pilot/actions/workflows/ci.yml)

**Zero-dependency, offline-first защита для кода, который пишет AI.** oc-pilot — это CLI, MCP-сервер и CI-гейт в одном пакете для Node.js 22+. Его задача — не писать фичи. Он механически проверяет код, который написал агент, до попадания в `main`.

[English](README.md) · [Русский](README.ru.md) · [Интеграции](docs/integrations.md) · [Безопасность](SECURITY.md) · [Участие](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

## Проблема

AI-агенты — отличные двигатели без тормозов. Они выдумывают несуществующие зависимости, ослабляют ассерты, пока тесты не станут зелёными, сливают секреты в diff и превращают чистую архитектуру в AI slop. Вручную ревьюить каждый diff агента не масштабируется, а «тесты прошли» — не аргумент о безопасности.

## Решение

oc-pilot — это тормоз. Он гоняет детерминированные проверки по diff, отдаёт агенту структурированные доказательства через MCP и блокирует мерж, когда доказательства плохие.

- **Offline first.** Сканирование секретов, SAST, проверка зависимостей и граф кода работают локально. Код не уходит в модель, если вы явно не вызвали model-backed команду.
- **Agent native.** Один MCP-сервер отдаёт review, fix, test-fix, scan, preflight, query и sandbox инструменты в Cursor, Claude Code, OpenCode и любой другой MCP-клиент.
- **CI ready.** `oc-pilot preflight` — единый гейт с ненулевым кодом возврата, GitHub-аннотациями и компактным JSON-отчётом.

## Посмотреть в деле

[Открыть asciinema-каст](https://github.com/MyNameIsNikki/oc-pilot/blob/main/docs/demo.cast) 30-дневной сессии oc-pilot или запустить тот же цикл локально:

```bash
oc-pilot battle "fix the retry logic" --apply --shadow --rounds 3
```

`battle` запускает coder и hacker на одном diff. Coder патчит; hacker ревьюит, гоняет SAST, проверяет авторизацию маршрутов и ищет ослабленные тесты. `--shadow` держит весь бой внутри `.oc-pilot/shadow-tree` — настоящего detached git worktree. Diff попадает в рабочее дерево только после зелёного раунда. Проиграть каст локально: `asciinema play docs/demo.cast`.

<p align="center">
  <img src="https://raw.githubusercontent.com/MyNameIsNikki/oc-pilot/main/docs/badges/oc-pilot.svg" alt="echo-бейдж oc-pilot, собранный из истории этого репозитория" width="120">
</p>

Этот бейдж собран командой `oc-pilot echo` из истории самого репозитория. Dogfooding, а не декорация.

## Почему oc-pilot?

- 🛡️ **Криптографические расписки, а не «поверьте на слово».** `oc-pilot receipt --sign --key <file>` прогоняет тесты и preflight, записывает коммит, diff и результаты, а затем подписывает расписку Ed25519. `oc-pilot ready` проверяет подпись, если рядом есть публичный ключ. Расписки включаются явно; ничего не подписывается втайне.
- 🧠 **Голографический контекст, а не свалка токенов.** `oc-pilot pack --hologram` собирает diff в три уровня детализации: LOD 0 оставляет изменённые файлы целиком, LOD 1 скрывает тела, но сохраняет сигнатуры и эффекты, LOD 2 перечисляет имена экспортов. Агент получает нужный контекст вместо дампа на 100k строк.
- 🔥 **Ноль зависимостей.** Чистый Node.js 22+, TypeScript ESM, без Python, Docker и нативных бинарников. `npm install -g oc-pilot` — вся установка.
- 🎮 **Gamified DX с зубами.** `bounty` рисует ASCII-постеры WANTED на опасные файлы, `roast` делает ревью diff в стиле Линуса, `brag` экспортирует самодостаточный HTML-отчёт сессии, а `cinema` превращает сессию в asciinema-каст или HTML-плеер.
- 🔒 **Offline-first безопасность.** Секреты, выдуманные зависимости, SQL-инъекции, SSRF, path traversal и XSS проверяются без сетевых вызовов. Модель опциональна, а не является движком.
- 🕸️ **Настоящий граф кода.** `oc-pilot query "find(CallExpression).where(name, 'stripe').select(file, line)"` отвечает на вопросы об архитектуре без grep. Это быстрый текстовый граф, а не полный TypeScript AST.

## Быстрый старт

```bash
npm install -g oc-pilot
oc-pilot setup --all
oc-pilot doctor
oc-pilot scan
```

`setup --all` пишет нативные MCP-конфиги для всех поддерживаемых клиентов и сохраняет существующие настройки. `doctor` проверяет установку, credentials движка, обнаружение тестов и MCP-подключение. `scan` читает текущий diff; на чистом дереве используйте `oc-pilot scan --staged` или `oc-pilot scan --base origin/main`.

Нужен Node.js 22+. Model-backed команды (`review`, `fix`, `roast`, `battle`) требуют OpenCode 2.x или OpenAI-совместимый endpoint; offline-команды работают без модели.

## Рецепты

```bash
# Прожарить AI-diff до человеческого ревью
oc-pilot roast --staged --persona linus

# Проверить подписанный compliance-манифест
oc-pilot compliance --verify

# Спрогнозировать, когда техдолг станет невыносимым
oc-pilot bankruptcy --explain

# Найти коммит, который внёс уязвимость
oc-pilot autopsy HEAD --depth 10

# Спросить граф кода, где живёт вызов
oc-pilot query "find(CallExpression).where(name, 'stripe').select(file, line)"

# Запустить сгенерированный скрипт с блокировкой импортов и side effects
oc-pilot sandbox run scripts/demo.mjs

# Проверить шифрованную сеть агентов
oc-pilot hivemind status
```

`bankruptcy` требует минимум 10 коммитов и остаётся эвристикой, а не обещанием. `sandbox run` изолирует JavaScript в `node:vm`; это не ОС-песочница для нативного кода. `hivemind` работает по шифрованному TCP, а не WebRTC, и доверяет узлам только после явного `hivemind trust`.

## В CI

```yaml
name: oc-pilot
on: [pull_request]

jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx -y oc-pilot preflight --base ${{ github.event.pull_request.base.sha }} --github
```

`preflight` проверяет секреты, детерминированный SAST, авторизацию маршрутов, здоровье зависимостей, ослабленные тесты и дельту Slop Index. При провале он возвращает ненулевой код, дальше работает branch protection.

## Под капотом

Никакой магии и скрытых облачных вызовов. Статический граф импортов и облегчённый текстовый AST питают `query`, `preflight`, `scan`, `deps` и `test-guard`. `test-guard` ловит классический ход агента: заменить `expect(x).toBe(200)` на `expect(x).toBeDefined()`, чтобы сборка стала зелёной. `fix --shadow` гоняет пропатченное дерево в настоящем detached git worktree, поэтому внешние компиляторы и тест-раннеры видят изменённые файлы; diff попадает в рабочее дерево только после зелёного прогона. `sandbox run` использует `node:vm` с блокировкой импортов, side effects и жёстким таймаутом.

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

# То же через пресет
oc-pilot review --engine-preset ollama --model qwen2.5-coder
```

Ключ читается из `OC_PILOT_API_KEY` или `OPENAI_API_KEY`; переменную можно переименовать через `--api-key-env` / `apiKeyEnv`. Ключ не попадает в логи и ошибки.

### Пресеты движков

Для частых OpenAI-совместимых провайдеров `--engine-preset` сам подставляет base URL, переменную с ключом и (где есть разумный дефолт) модель:

| Пресет | Base URL | Переменная ключа | Модель по умолчанию |
| --- | --- | --- | --- |
| `ollama` | `http://localhost:11434/v1` | `OLLAMA_API_KEY` (на loopback не нужен) | `llama3.2` |
| `lmstudio` | `http://localhost:1234/v1` | `LMSTUDIO_API_KEY` (на loopback не нужен) | — |
| `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | — |

Пресет переключает движок на `openai`, если явно не указано иное, а явные флаги всегда важнее: `oc-pilot review --engine-preset ollama --model qwen2.5-coder` оставит endpoint из пресета и переопределит только модель.

### Движок Anthropic

`--engine anthropic` работает с Claude Messages API напрямую, без SDK:

```bash
ANTHROPIC_API_KEY=sk-ant-... oc-pilot review --engine anthropic --model claude-sonnet-4-5
```

Системный промпт уходит блоком `system` с `cache_control: {"type": "ephemeral"}`, поэтому повторные ревью переиспользуют закэшированный префикс. Запросы несут `anthropic-version: 2023-06-01` и `x-api-key`. Расход токенов попадает в ту же таблицу цен, что и у движка `openai`, так что `--max-cost` и `oc-pilot stats` работают без изменений.

Slicing, двухфазный роутинг и кеш ответов остаются только у `openai`: движок Anthropic всегда отправляет один запрос за прогон.

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

Рядом с бюджетом вызовов есть бюджет денег: `--max-cost <usd>` (или `maxCostUsd`, `OC_PILOT_MAX_COST`; `0` — без лимита) ограничивает дневные расходы на вызовы `openai`. Стоимость считается по `usage` из ответа модели и встроенной таблице цен (gpt-4.1 с вариантами mini/nano, gpt-4o, o4-mini, o3-mini), копится в `stats.jsonl` и суммируется за сегодня; при превышении команда выходит с кодом 1. Это страховка от зацикленного агента, а не бухгалтерия: для моделей вне таблицы стоимость считается нулевой, попадания в кеш бесплатны.

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
| `--engine-preset <p>` | пресет API: `ollama`, `lmstudio`, `openrouter` |
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
| `--mr` | отправить review в merge request GitLab (`CI_MERGE_REQUEST_IID`) |
| `--no-mr-inline` | только сводная заметка в MR, без inline-обсуждений |
| `--mr-status` | выставить статус `oc-pilot` в GitLab (`GITLAB_TOKEN`) |
| `--second-opinion` | проверить критичные находки второй моделью (`openai`) |
| `--second-opinion-model <m>` | модель-верификатор (по умолчанию `secondOpinionModel` или основная) |
| `--require-tests` | код 3, если логика изменена без тестов |
| `--no-test-weakening` | код 3, если тесты ослаблены (skip, удалённые проверки) |
| `--interactive` | по каждой находке спросить, не скрыть ли её в baseline (TTY) |

С `--baseline` находки, уже записанные в `.oc-pilot/baseline.json`, скрываются из вывода и не влияют на код возврата, JSON, SARIF и PR-комментарий — блокируют только новые. Отпечаток находки — `severity | файл | нормализованный текст`, без номера строки, поэтому известные находки переживают сдвиги кода. `--update-baseline` перезаписывает файл по текущему ревью и выходит с кодом 0; `--interactive` прячет находки по одной и дописывает их в baseline. `--pr` отправляет ревью в текущий PR: внутри GitHub Actions — через review API с `GITHUB_TOKEN`, до 25 находок прикрепляются inline-комментариями к своим строкам диффа (нужна permission `pull-requests: write`); находки вне изменённых строк и любой запуск вне Actions откатываются на один сводный комментарий (локально — через `gh pr comment`, нужен установленный и авторизованный `gh`). `--no-pr-inline` принудительно оставляет только сводный комментарий. `--pr-status` выставляет commit status в контексте `oc-pilot` — `failure`, пока остаются critical-находки, иначе `success` — чтобы правило защиты ветки могло его требовать (нужна `statuses: write`). Работает и в текстовом, и в SARIF-режиме.

В GitLab CI `--mr` отправляет ревью в merge request: до 25 находок становятся inline-обсуждениями, привязанными к своим строкам диффа, а сводка всегда уходит заметкой. `CI_MERGE_REQUEST_IID`, `CI_PROJECT_ID` и `CI_API_V4_URL` указывают на MR, а `GITLAB_TOKEN` должен иметь scope `api` (`CI_JOB_TOKEN` не умеет писать заметки). Для позиции обсуждения нужны `base_sha`/`start_sha`/`head_sha`: они берутся из `CI_MERGE_REQUEST_DIFF_BASE_SHA`, `CI_MERGE_REQUEST_TARGET_BRANCH_SHA` и `CI_COMMIT_SHA`, а если их нет — запрашиваются у merge request как `diff_refs`. `--no-mr-inline` оставляет только сводную заметку. Добавьте `--mr-status`, чтобы выставить и commit status `oc-pilot`. Любая часть при отсутствии контекста пайплайна, токена или отдельной позиции деградирует до предупреждения, поэтому ревью никогда не падает из-за неготовой интеграции.

Минимальная задача выглядит так:

```yaml
oc-pilot:
  image: node:22
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  script:
    - npm i -g oc-pilot
    - oc-pilot review --base "origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME" --fail-on critical --mr --mr-status
  variables:
    OC_PILOT_API_KEY: $OC_PILOT_API_KEY
    GITLAB_TOKEN: $GITLAB_TOKEN
```

До вызова модели `review` сам осматривает diff: новые зависимости проверяются на тайпосквоты, незакреплённые версии и VCS/URL-спеки в манифестах npm, PyPI, Go, Cargo, RubyGems, Packagist, Maven/Gradle и NuGet (подсказка `DEPENDENCY_CHANGES`, `meta.dependencies`); крупное изменение логики (20+ добавленных строк кода) без тестов даёт `TEST_COVERAGE_HINT` (`--require-tests` превращает в код 3, `meta.testDelta`); ослабленные тесты дают `TEST_WEAKENING` (пропущенные и сфокусированные тесты, удалённые проверки без замены, закомментированные ассерты, поднятые таймауты; `--no-test-weakening` превращает в код 3, `meta.testWeakening`); добавленные строки с признаками prompt injection (переопределение инструкций, role-hijack, эксфильтрация промпта, base64-блобы, невидимый Unicode) дают предупреждение `PROMPT_INJECTION_RISKS` (`meta.injection`).

### Подавление находок в коде

Осознанный компромисс не должен возвращаться замечанием в каждом ревью. Пометьте его в самом коде:

```go
func pay() {} // oc-pilot:ignore: nil невозможен для старого кошелька
```

Маркер подавляет находку, чья цель — эта строка или строка сразу под ним, поэтому он работает и отдельным комментарием над кодом. `// oc-pilot:ignore-file: код сгенерирован protoc` в первых десяти строках файла отключает ревью для всего файла. Причина обязательна: голый `oc-pilot:ignore` не действует, находка остаётся, а прогон выдаёт предупреждение. Подавленные находки исчезают из текста, JSON, SARIF и комментариев PR или MR и не влияют на код возврата, но `meta.suppressed` перечисляет каждую с файлом, строкой и причиной. `oc-pilot:ignore-secret` относится к сканеру секретов и никогда не скрывает находку ревью.

### `test-fix`

```bash
oc-pilot test-fix
oc-pilot test-fix --command "go test ./..."
oc-pilot test-fix --log failures.log
oc-pilot test-fix --log - --exit-code 1
```

Команда тестов определяется автоматически по `package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`, `pom.xml`, Gradle, `Package.swift`, `mix.exs`, `pubspec.yaml`, `Gemfile`, `composer.json`, `*.csproj` или `Makefile`. Если определить не удалось — укажите `--command` или `testCommand` в конфиге.

`test-fix` прикладывает diff (если это git-репозиторий), выдержки из файлов, найденных в стеке, и последние строки вывода. Успешный прогон не анализируется, если не передан `--force`.

### `test-gen`

Превращает diff в тесты, которые действительно запускаются. Модель пишет тесты на поведение, изменённое в диффе, патч применяется, `testCommand` выполняется, и остаётся только зелёный результат: неудачная попытка откатывается, а лог падения уходит обратно в модель как обратная связь.

```bash
oc-pilot test-gen --staged --apply
oc-pilot test-gen --staged --coverage --apply
oc-pilot test-gen --from-slop --apply
oc-pilot test-gen src/billing.ts --apply --rounds 1
oc-pilot test-gen --base main --json
oc-pilot test-gen --diff changes.diff
```

Без `--apply` команда только печатает патч. Патч может менять только тестовые файлы (`*.test.ts`, `*.spec.ts`, `*_test.go`, `test_*.py` или пути внутри `test/`); производственный файл в патче отклоняет весь раунд. Существующие тесты защищены, пока не передан `--force`, поэтому сгенерированные тесты не перезаписывают написанные вручную. `--no-run` применяет патч без запуска набора, `--keep-failing` оставляет красный тест для отладки, а `--rounds <n>` (по умолчанию 2) задаёт, сколько раз падение отправляется модели.

`--coverage` сужает запрос до изменённых строк, которые ещё не выполнил ни один тест. Команда читает отчёт lcov, Istanbul JSON, Cobertura XML или Go cover profile (`--coverage-file <path>` переопределяет автоопределение `coverage/lcov.info`, `coverage/coverage-final.json`, `cobertura.xml`, `coverage.out` и похожих файлов), пересекает его со строками, добавленными в диффе, и отправляет модели только эти пробелы. Если все изменённые строки уже покрыты, команда выходит с кодом 0, не вызывая модель.

`--from-slop` игнорирует diff и позволяет скану slop выбрать работу: команда ищет исходники, у которых нет тестов, и ранжирует их по churn, дублированным блокам и нерешённым TODO. `--slop-files <n>` (по умолчанию 3) ограничивает число файлов. Смешивать `--from-slop` с `--diff`, `--staged`, `--base`, `--coverage` или явными путями нельзя: они уже задают вход. Если тест есть у каждого исходника, команда выходит с кодом 0, не вызывая модель.

JSON-результат — `{applied, patch, files, status, tests, rounds, analysis, meta, coverage, targets}`, где `status` равен `pass`, `fail` или `not-run`, `coverage` содержит `{report, format, uncoveredLines, gaps, missing}` (или `null` без `--coverage`), а `targets` перечисляет выбранные сканом файлы с оценками и причинами (или `null` без `--from-slop`); код возврата 1, пока тесты остаются красными.

### `fix`

Просит модель вернуть unified diff, проверяет его через `git apply --check` и с `--apply` применяет в рабочем дереве. Это единственная команда, которая меняет файлы.

```bash
oc-pilot fix --diff changes.diff                 # только показать патч
oc-pilot fix --apply --command "npm test"        # применить и проверить
oc-pilot fix --apply --command "go test ./..." --keep-on-test-failure
oc-pilot fix --from-sast --staged --apply        # починить SAST-находки
oc-pilot fix --from-authz --staged --apply       # починить находки авторизации
oc-pilot review --github                         # аннотации GitHub Actions
```

| Опция | Назначение |
| --- | --- |
| `--apply` | применить патч к рабочему дереву |
| `--command <cmd>` | тесты после применения; иначе `testCommand` или автоопределение |
| `--no-tests` | применить без запуска тестов |
| `--keep-on-test-failure` | не откатывать патч при падении тестов |
| `--no-snapshot` | не создавать снимок перед применением |
| `--from-sast` | исправить high-находки SAST в изменённых файлах и пересканировать |
| `--from-authz` | исправить high-находки авторизации маршрутов и пересканировать |

`fix` не делает commit и push. При падении тестов патч откатывается, если не указан `--keep-on-test-failure`. Чужие незакоммиченные изменения не откатываются.

Перед применением `fix` сохраняет снимок рабочего дерева в `.git/oc-pilot/snapshots/` (tracked-изменения бинарным патчем + копии untracked-файлов). Снимки локальны: они не попадают в коммиты. Откат — `oc-pilot restore`; отключить снимок — `--no-snapshot`.

С `--from-sast` команда сканирует изменённые файлы встроенными правилами SAST, просит модель о патче, применяет его и пересканирует. В JSON добавляется `sast: {before, after, remaining}`; код 1, если high-находки остались.

С `--from-authz` тот же цикл работает с находками авторизации маршрутов (маршрут без сессии, IDOR, админка без роли), а в JSON добавляется `authz: {before, after, remaining}`; `--from-sast` и `--from-authz` несовместимы.

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

### `preflight`

Один офлайн-вердикт перед коммитом. Шесть проверок идут без модели и без сети: секреты в диффе, детерминированный SAST по изменённым исходникам (инъекции команд и SQL, path traversal, SSRF, выполнение кода, XSS и другое), авторизация маршрутов по изменённым исходникам (маршрут без сессии, IDOR, админский путь без роли), здоровье зависимостей в границах изменённых файлов, ослабление тестов (`it.skip`, удалённые проверки, поднятые таймауты) и дельта Slop Index относительно базовой ссылки.

```bash
oc-pilot preflight
oc-pilot preflight --staged
oc-pilot preflight --base main --max-delta 0
oc-pilot preflight --no-slop --fail-on-issue medium
oc-pilot preflight --staged --no-sast
```

Проблемы зависимостей ограничены скоупом: preflight сообщает только о файлах, которые меняет дифф, и о пакетах, названных в добавленных строках, поэтому старый репозиторий не падает на первом же запуске. Находки, записанные в `.oc-pilot/baseline.json`, по умолчанию скрываются, поэтому гейт сообщает только о новых проблемах; `receipt` использует тот же baseline. `--fail-on-issue` (по умолчанию `high`) задаёт порог и для находок SAST, и для авторизации маршрутов, и для severity зависимостей, а `--max-delta` (по умолчанию 10 пунктов) — порог Slop Index; каждую проверку можно отключить через `--no-secret-scan`, `--no-sast`, `--no-authz`, `--no-deps`, `--no-tests` или `--no-slop`. Код возврата 1, если хоть одна проверка упала, иначе 0 — один шаг CI заменяет шесть.

JSON-отчёт — `{status, checks, diff}`, где каждая проверка содержит `{id, label, status, summary, details}`, а `status` равен `pass`, `fail` или `skip`.

### `receipt`

Превращает «у меня работает» в проверяемое утверждение. Квитанция прогоняет тесты и preflight (включая SAST и authz), а затем записывает результат вместе с SHA коммита, веткой, состоянием рабочего дерева, статистикой диффа и точными командами. Файл пишется в `.git/oc-pilot/receipt.json`, поэтому никогда не попадает в рабочее дерево. `--no-sast` или `--no-authz` пропускает проверку для изменения, где она неприменима.

```bash
oc-pilot receipt --staged
oc-pilot receipt --staged --no-sast
oc-pilot receipt --json
oc-pilot receipt --verify
oc-pilot receipt --verify --receipt path/to/receipt.json
oc-pilot receipt --keygen receipt.key
oc-pilot receipt --sign --key receipt.key
oc-pilot receipt --verify --public-key receipt.key.pub
```

Файл запечатан SHA-256 хешем тела. `--verify` пересчитывает хеш и сравнивает коммит с текущим `HEAD`, поэтому изменённый файл или квитанция от старого коммита считаются недействительными: `{path, ok, hashOk, stale, commit, head, signature, reason?}`. Код возврата 1, если тесты упали, preflight не прошёл или квитанция не проверяется.

Хеш доказывает целостность, но не авторство. `--sign` подписывает хеш Ed25519-ключом: `--keygen <file>` создаёт приватный ключ (права 0600) и `<file>.pub`; `--key` или `OC_PILOT_RECEIPT_KEY` указывает на приватный ключ; в квитанции появляется поле `signature`. Проверка сверяет подпись, если доступен публичный ключ: `--public-key <file>`, `OC_PILOT_RECEIPT_PUBLIC_KEY` или закоммиченный `.oc-pilot/receipt.pub`. Статус подписи — `valid`, `invalid`, `missing` или `unchecked`; неподписанная квитанция не проходит проверку, когда ключ передан. `ready` тоже проверяет подпись, если существует `.oc-pilot/receipt.pub`. Приватный ключ храните вне репозитория.

Квитанция содержит `{version, tool, toolVersion, createdAt, commit, branch, dirty, diff, files, tests, preflight, hash, signature?}`. `tests` — `{command, exitCode, timedOut, durationMs, passed, outputTail}` или `null` при `--no-run`; `preflight` — тот же отчёт, что печатает `preflight`. Вне репозитория квитанцию можно записать только в явный путь через `--out`.

### `ready`

Оценивает готовность репозитория к работе с ИИ-агентом. Одно офлайн-число от 0 до 100 по девяти проверкам: тесты (15), lockfile (10), git-хуки (15), Slop Index (15), свежая квитанция (10), инструкции для агента (10), CI (5), конфиг (5) и безопасность (15). Каждая проверка даёт `pass`, `warn` или `fail` и приносит 100%, 50% или 0% своего веса. Проверка безопасности прогоняет детерминированные правила SAST и авторизации маршрутов по репозиторию и учитывает `.oc-pilot/baseline.json`. Модель не вызывается, сеть не используется, но нужен git-репозиторий.

```bash
oc-pilot ready
oc-pilot ready --json
oc-pilot ready --badge
oc-pilot ready --fail-under 85
oc-pilot ready --fix
oc-pilot ready --fix --dry-run
oc-pilot ready --fix --receipt
```

Оценка переводится в грейд: 85 и выше — `agent-ready`, 65 и выше — `almost`, 40 и выше — `risky`, ниже — `not-ready`. `--badge` печатает shields.io-бейдж в markdown для README, а `--fail-under <n>` возвращает код 1 ниже порога, поэтому оценкой можно гейтить pull request.

`--fix` применяет только безопасные офлайн-исправления: ставит хук `pre-commit`, если хука нет, пишет `.oc-pilot.json` с найденной тестовой командой и создаёт `AGENTS.md` с командами проекта. Чужой хук, существующий конфиг или готовые инструкции для агента не перезаписываются — они попадают в список пропущенных вместе с проверками, которые требуют человека: квитанция, lockfile и Slop Index. `--dry-run` печатает план, не трогая дерево, а после исправлений оценка пересчитывается.

`--receipt` превращает `--fix` в полный цикл: после исправлений команда прогоняет тесты, запускает preflight и сохраняет квитанцию для `HEAD`, поэтому проверка квитанции проходит в том же запуске. Флаг работает только вместе с `--fix`; без тестовой команды квитанция попадает в пропущенные. Упавшие тесты или проваленный preflight всё равно создают квитанцию — отчёт скажет, что именно не прошло.

JSON-результат — `{score, grade, checks, commit}`; каждая проверка — `{id, label, status, points, max, detail}`, где `detail` называет файл, который принёс или потерял очки, и команду, которая это исправляет. С `--fix` в payload добавляется `fix: {applied, dryRun, fixes, skipped, receipt}`, где `receipt` — `{path, testsPassed, preflight}` или отсутствует.

### `mutate`

Мутационное тестирование отвечает на вопрос сложнее покрытия: тесты действительно ловят баги? Команда переворачивает операторы сравнения и булевы операторы в изменённых исходниках, прогоняет набор тестов на каждой мутации и считает, сколько мутантов тесты убили. Выживший мутант — это строка, которую набор исполняет, но по-настоящему не проверяет.

```bash
oc-pilot mutate --staged
oc-pilot mutate --base main --max-mutants 10
oc-pilot mutate src/billing.ts --min-score 80
oc-pilot mutate --diff changes.diff --json
```

Операторы: `===`/`!==`, `==`/`!=`, `>=`/`<`, `<=`/`>`, `&&`/`||` и `true`/`false`; строки и комментарии маскируются, поэтому мутируется только реальный код. `--max-mutants <n>` ограничивает прогон (по умолчанию 20, максимум 500), потому что каждый мутант запускает весь набор. `--min-score <n>` возвращает код 1, если mutation score ниже порога, — это CI-гейт. Таймаут считается убийством: мутант изменил наблюдаемое поведение.

JSON: `{command, files, sites, mutants, killed, survived, timedOut, score, truncated, durationMs}`; каждый мутант — `{file, line, column, operator, original, replacement, status, durationMs}` со `status` равным `killed`, `survived` или `timeout`.

### `flaky`

Запускает тестовую команду несколько раз и сравнивает результаты отдельных тестов. Тест, который прошёл в одном прогоне и упал в другом, помечается нестабильным; тест, падающий каждый раз, — просто сломанным. Модель не вызывается, команда работает только с выводом раннера.

```bash
oc-pilot flaky
oc-pilot flaky --runs 5
oc-pilot flaky --shuffle --command "node --test {files}"
oc-pilot flaky --command "go test ./..." --json
oc-pilot flaky --fail-on-flaky
```

`--runs <n>` задаёт число прогонов (по умолчанию 3, максимум 10). `--command` переопределяет `testCommand` и автоопределение. `--fail-on-flaky` возвращает код 1, если найден хотя бы один нестабильный тест, — это готовый CI-гейт.

`--shuffle` превращает прогон в проверку порядка. Команда должна содержать `{files}`: `oc-pilot flaky --shuffle --command "node --test {files}"`. Тестовые файлы собираются из репозитория, перемешиваются seeded-генератором и подставляются в команду; каждый прогон получает новый seed от базового, поэтому тест, падающий только после определённого соседа, проявляется как нестабильный. `--seed <value>` фиксирует базовый seed, когда нужно воспроизвести падение.

Распознаются Node spec (`✔`/`✖`), TAP (`ok`/`not ok`), Go (`--- PASS`/`--- FAIL`), pytest (`PASSED`/`FAILED`) и Jest/Vitest (`✓`/`✕`). Если маркеров нет, `parsed` равен `false`, и команда честно сравнивает только коды возврата.

JSON: `{command, runs, completed, parsed, tests, flaky, failing, shuffle}`, где каждый тест — `{name, passes, failures, status}` со `status` равным `flaky`, `failing` или `passing`. С `--shuffle` поле `shuffle` равно `{seed, files}`.

### `authz`

Проверка авторизации HTTP-маршрутов: маршрут без проверки сессии, объект, который достаётся по id из запроса без проверки владельца (IDOR), и админский путь без роли. Команда читает изменённые исходники и не вызывает модель.

```bash
oc-pilot authz --staged
oc-pilot authz --public /health,/login
oc-pilot authz --staged --fail-on-issue medium
oc-pilot authz --staged --format sarif -o authz.sarif
```

Распознаются маршруты Express, Fastify и Koa (`app.get`, `router.post`, ...), а также Next.js `app/**/route.ts` и `pages/api/**`. Handler по ссылке (`router.get("/x", controller.list)`) пропускается: проверка может жить в контроллере. Пути `/health`, `/login`, `/signup`, `/public`, `/webhooks`, `/oauth` и подобные считаются публичными; `--public <prefixes>` расширяет список.

Осознанное исключение подавляется на строке маршрута или строкой выше:

```js
// oc-pilot:authz-ignore idor: шлюз ограничивает запрос тенантом
router.get("/users/:id", handler);
```

Подавление без причины игнорируется. `--ignore <rules>` отключает целые правила, `--no-suppressions` отключает inline-подавления.

`--fail-on-issue <high|medium>` задаёт порог для кода возврата (по умолчанию `high`). `--format sarif` выдаёт SARIF 2.1.0 с правилом, методом и маршрутом.

`--baseline <file>` скрывает находки, уже записанные в `.oc-pilot/baseline.json`, поэтому падают только новые; `--update-baseline` записывает текущие находки в файл и выходит с кодом 0 — так легаси-репозиторий может включить гейт, не исправляя всё сразу. Baseline хранит SHA-256-отпечатки правила, файла и фрагмента (или метода и маршрута для `authz`), поэтому записи переживают сдвиги строк. `preflight` и `receipt` читают тот же baseline по умолчанию.

JSON: `{files, routes, findings, suppressed, summary}`; каждый маршрут — `{file, line, method, route, public}`, находка добавляет `{rule, severity, method, route}`. С `--baseline` в payload добавляется `baselineSuppressed`, с `--update-baseline` — `baseline: {path, updated, entries}`.

### `sast`

Детерминированный статический анализ изменённых файлов: инъекции команд и SQL, path traversal, SSRF, выполнение кода, XSS, открытые редиректы, отключённая проверка TLS, wildcard CORS, prototype pollution, слабые хеши и JWT `none`. Модель не вызывается, сеть не используется: один и тот же дифф всегда даёт одни и те же находки.

```bash
oc-pilot sast --staged
oc-pilot sast --base main --fail-on-issue medium
oc-pilot sast src/server.ts --json
oc-pilot sast --staged --format sarif -o sast.sarif
```

Анализ учитывает источники данных, но остаётся эвристическим: сток (sink) помечается, когда данные запроса (`req.query`, `req.body`, `req.params`, заголовки, cookies, `userInput`, `untrusted*`) или подстановка шаблона доходят до него в том же выражении. Константы и параметризованные запросы не помечаются. `path.resolve`, `path.normalize`, `path.basename` и `path.join` снимают находку path traversal.

Осознанное исключение подавляется на строке находки или строкой выше:

```js
exec(req.query.cmd); // oc-pilot:sast-ignore command-injection: admin-only endpoint
```

Подавление без причины игнорируется. `--ignore <rules>` отключает целые правила, `--no-suppressions` отключает inline-подавления для аудита.

`--fail-on-issue <high|medium|low>` задаёт порог для кода возврата (по умолчанию `high`). `--format sarif` выдаёт SARIF 2.1.0 для GitHub code scanning и других потребителей.

`--baseline <file>` скрывает находки, уже записанные в `.oc-pilot/baseline.json`, поэтому падают только новые; `--update-baseline` записывает текущие находки в файл и выходит с кодом 0 — так легаси-репозиторий может включить гейт, не исправляя всё сразу. Baseline хранит SHA-256-отпечатки правила, файла и фрагмента, поэтому записи переживают сдвиги строк. `preflight` и `receipt` читают тот же baseline по умолчанию.

JSON: `{files, findings, suppressed, summary}`, каждая находка — `{rule, severity, file, line, column, message, snippet}`, `summary` считает `high`, `medium`, `low`. С `--baseline` в payload добавляется `baselineSuppressed`, с `--update-baseline` — `baseline: {path, updated, entries}`.

### `deps`

Офлайн-аудит здоровья npm-, pnpm- и yarn-зависимостей. Модель не вызывается, сеть не используется.

```bash
oc-pilot deps
oc-pilot deps --json
oc-pilot deps --fail-on-issue high
oc-pilot deps --ignore lint-staged
oc-pilot deps --fix --dry-run
oc-pilot deps --fix
oc-pilot deps --why qs
oc-pilot deps --audit --fail-on-vuln high
oc-pilot deps --audit --offline
oc-pilot deps --sbom sbom.json
```

Команда сравнивает `package.json` с тем, что код реально импортирует, и с лок-файлом проекта: `package-lock.json`, `pnpm-lock.yaml` или `yarn.lock`:

- **phantom** (high) — пакет импортируется, но не объявлен, поэтому чистая установка или CI упадёт;
- **unused** (medium) — объявлен, но нигде не импортируется и не упоминается в скриптах;
- **misplaced** (low) — используется только тестами, но лежит в `dependencies`;
- **duplicate** (low) — две библиотеки из одной группы решают одну задачу (`moment` и `dayjs`);
- **unpinned** (medium) — `*`, `latest` или пустая версия;
- **vcs** (high для git/URL, low для `file:`) — зависимость из git, URL или локального пути;
- **lockfile** (high) — объявлен, но отсутствует в лок-файле проекта, поэтому чистая установка упадёт (`npm ci`, `pnpm install --frozen-lockfile` или `yarn install --immutable`).

`--fail-on-issue <high|medium|low>` превращает аудит в CI-гейт (код 1). `--ignore <names>` принимает список через запятую для ложных срабатываний, например когда пакет загружается динамически. Workspace-пакеты (`packages/*`) и `@types/*` учитываются, peer-зависимости не считаются неиспользуемыми.

`--fix` исправляет то, что можно решить офлайн: пакет, используемый только тестами, переезжает в `devDependencies`; импортируемый, но не объявленный пакет добавляется с версией, уже разрешённой в лок-файле (в `devDependencies`, если все импортёры — тесты); плавающая версия `*`/`latest` прибивается к версии из lockfile. Ничего не выдумывается: фантомный импорт без записи в lockfile, неиспользуемый пакет, дубликат и vcs-зависимость попадают в `skipped` с причиной. `--dry-run` печатает план, не трогая `package.json`. После записи аудит запускается заново, поэтому код возврата отражает уже исправленное состояние.

`--why <name>` отвечает на вопрос, который возникает до любой чистки: откуда этот пакет вообще взялся. Команда локально читает `package.json` и лок-файл проекта и показывает поле и спецификацию объявления, файлы с прямым импортом, пакеты, которые от него зависят, все установленные версии и число копий, а также цепочки зависимостей от корня. Если пакет не объявлен, не установлен и не импортируется, код возврата 1. `--why` не сочетается с `--fix`.

`--audit` добавляет известные уязвимости и лицензии. Команда спрашивает OSV (`api.osv.dev`) по каждому пакету из lockfile, показывает CVE/GHSA, severity и первую исправленную версию, а ответы кеширует в `.oc-pilot/osv-cache.json` на 24 часа. `--offline` использует только кеш, не ходит в сеть и падает, если кеш пуст. `--osv-url` направляет запрос на зеркало. `--fail-on-vuln <critical|high|medium|low>` превращает результат в security-гейт: код 1, если хотя бы одна уязвимость достигает порога. Лицензии читаются из установленных манифестов в `node_modules`; strong copyleft, proprietary и unknown попадают в отчёт, а пакеты без установленного манифеста считаются `missing`, а не угадываются.

`--sbom <file>` записывает CycloneDX 1.5 SBOM по каждому пакету из lockfile, с npm purl, относительно корня проекта. Сеть не нужна.

JSON-результат — `{packageName, declared, imported, scannedFiles, truncated, lockfile, issues}`; с `--fix` добавляется `fix: {applied, dryRun, fixes, skipped}`, с `--why` команда печатает один объект `DependencyWhy`: `{name, versions, copies, declared, importedBy, dependents, chains}`, с `--audit` добавляется `audit: {checked, unchecked, vulnerabilities, online, stale, cachePath, licenses}`, а с `--sbom` — `sbom: <path>`.

### `commit`

Генерирует commit-сообщение в формате Conventional Commits по staged-изменениям и опционально коммитит. Модель видит последние 10 commit-сообщений проекта и подстраивается под их стиль.

```bash
oc-pilot commit               # вывести сообщение
oc-pilot commit --apply       # закоммитить staged с готовым сообщением
oc-pilot commit --json        # машиночитаемый вывод
```

`--apply` работает только со staged и блокируется (код `3`) при critical-секретах в diff; `--allow-secrets` снимает блокировку. С `--engine openai` большой diff разбивается на слайсы (см. «Движки»), сообщение покрывает все файлы.

### `install-hook`

Ставит нативные git-хуки без husky и зависимостей. Хук `pre-commit` запускает `oc-pilot preflight --staged`: секреты, SAST, авторизация маршрутов, здоровье зависимостей в границах изменения, ослабление тестов и дельта Slop Index. С `--pre-push` дополнительно ставится `pre-push` с `oc-pilot review --fail-on critical --fail-on-secrets`. Флаг `--scan` оставляет лёгкий pre-commit только с `oc-pilot scan --staged`.

```bash
oc-pilot install-hook
oc-pilot install-hook --scan
oc-pilot install-hook --pre-push
oc-pilot install-hook --uninstall
```

Хуки опциональны и обратимы. Чужой хук не перезаписывается без `--force`, а при замене сохраняется как `<hook>.oc-pilot.bak`. Каждый управляемый хук помечен маркером; хуки старых версий `oc-pilot doctor` показывает как устаревшие и обновляет через `oc-pilot doctor --fix`. Обход на одну команду — `OC_PILOT_SKIP=1`. Поддерживаются `core.hooksPath` и worktrees.

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

### `explain`

Объясняет находки прошлого ревью для одного места в коде. Каждый запуск `review` сохраняет замечания в `.git/oc-pilot/last-review.json`; `explain` находит замечание на указанной строке или ближайшее в пределах трёх строк и печатает его рядом с фрагментом текущего файла. Секреты в сниппете маскируются тем же сканером, что и везде.

```bash
oc-pilot explain src/wallet.ts:42
oc-pilot explain src/wallet.ts:42 --json
```

Без номера строки — или если совпадений нет — команда показывает все находки по этому файлу, так что она остаётся полезной, когда строки сдвинулись.

### `reviewers`

Предлагает, кому отдать текущий diff на ревью. Для каждого изменённого файла команда смотрит последние коммиты, которые его трогали, считает авторов и выбирает лучших кандидатов; боты пропускаются. `CODEOWNERS` читается из `.github/CODEOWNERS`, `CODEOWNERS` или `docs/CODEOWNERS` и матчится по тем же правилам, что в GitHub и GitLab: побеждает последнее подходящее правило.

```bash
oc-pilot reviewers --base main
oc-pilot reviewers --staged --limit 5 --exclude renovate
oc-pilot reviewers --base main --json -o reviewers.json
```

`--depth` увеличивает глубину истории (по умолчанию 50 коммитов). `--json` отдаёт файлы, кандидатов (`name`, `email`, `commits`, `files`, `share`) и найденных `codeowners` — этого достаточно, чтобы подставить имена в `gh pr create --reviewer`.

### `replay`

Повторно выводит последнее сохранённое ревью, не вызывая модель. Каждый `review` пишет `.git/oc-pilot/last-review.json`, поэтому SARIF-отчёт или комментарий для PR можно перегенерировать бесплатно — или отдать файл коллеге.

```bash
oc-pilot replay
oc-pilot replay --format sarif -o report.sarif
oc-pilot replay --as md -o pr-comment.md
oc-pilot replay --in saved.json --fail-on critical
```

`--format` понимает text, json и sarif; `--as` добавляет md для тела комментария в PR. `--in` читает любой файл с массивом `findings`. Код возврата считается по `--fail-on`, как в `review`.

### `slop`

Измеряет энтропию, которую оставляет быстрая генерация кода. `oc-pilot slop` оценивает репозиторий от 0 (чисто) до 100 (гниёт) без API-ключа, модели и сети: нужны только git и рабочее дерево.

| Категория | Что находит | Максимум |
| --- | --- | --- |
| Дубликаты | Блоки от 72 токенов, повторённые в двух разных файлах | 30 |
| Мёртвый код | Экспорты, имя которых не встречается ни в одном другом файле (type-only экспорты и точки входа пропускаются) | 25 |
| Churn без тестов | Файлы, изменённые в пяти и более коммитах, тогда как тесты менялись менее чем в 40% из них | 25 |
| TODO-кладбище | `TODO`, `FIXME`, `HACK` и `XXX` в комментариях, с весом по возрасту из `git blame` | 20 |

```bash
oc-pilot slop
oc-pilot slop --since origin/main --max-delta 10
oc-pilot slop --json -o slop.json
oc-pilot slop --badge -o slop.svg
```

`--since <ref>` сравнивает рабочее дерево с ревизией и показывает, что ветка добавила и убрала по каждой категории, плюс `deltaPoints`. Дельта важнее абсолютного числа: репозиторий может стоять на 50 и при этом быть стабильным.

Остальные флаги: `--limit` (элементов на категорию), `--since-days` (окно churn и blame, по умолчанию 30), `--exclude` (глобы или подстроки), `--no-blame` (без `git blame`, заметно быстрее), `--max-index` и `--max-delta` (код возврата 3 при превышении), `--badge` (SVG в стиле shields), `--json`.

Ложные срабатывания выносятся в `.oc-pilot/slopignore`: по одному глобу или подстроке на строку, `#` начинает комментарий. Перед анализом из кода вырезаются комментарии и строковые литералы, а тестовые, сгенерированные файлы и lock-файлы пропускаются. Оценка — эвристика, а не приговор.

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
oc-pilot init --hooks
```

Создаёт `.oc-pilot.json` с настройками по умолчанию. С `--preset <a,b>` дополнительно пишет готовый `.oc-pilot/rules.md` под стек. Пресеты можно комбинировать, например `--preset react,security`:

`base` (универсальный), `node`, `react`, `next`, `vue`, `svelte`, `angular`, `typescript`, `python`, `go`, `rust`, `java`, `kotlin`, `csharp`, `swift`, `php`, `ruby`, `flutter`, `elixir`, `zig`, `scala`, `security` (сквозная безопасность), `devops` (Docker, CI, инфраструктура).

Это обычный файл правил — дополняйте его свободно.

`--hooks` ставит те же git-хуки, что и `install-hook`: `preflight --staged` на коммит и `review` на пуш. Существующие хуки сохраняются в бэкап, а отсутствие каталога хуков даёт только предупреждение, поэтому `init` из-за этого не падает.

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

`oc-pilot-mcp` — MCP-сервер для Claude Code, Codex, Cursor, Gemini CLI, OpenCode, ZCode и любых клиентов с `.agents/mcp.json`. Он даёт агенту инструменты `review`, `invariants`, `test_fix`, `fix`, `test_gen`, `docgen`, `custom`, `scan`, `commit`, `stats`, `slop`, `mutate`, `fuzz`, `bankruptcy`, `query_ast`, `sandbox`, `hivemind_status`, `flaky`, `impact`, `deps`, `coverage`, `reviewers`, `test_guard`, `env_sync`, `mock_leak`, `ecosystem_verify`, `pack`, `pack_hologram`, `zoom_symbol`, `contract_drift`, `anti_regression`, `boundaries`, `test_plan`, `compliance_verify`, `brag`, `cleanup`, `arch_diff`, `roast`, `cinema`, `bounty`, `autopsy`, `echo`, `sast`, `preflight`, `ready`, `receipt_verify`, а модель и доступ к репозиторию остаются в вашем CLI.

Помимо инструментов сервер отдаёт read-only MCP-ресурсы: `oc-pilot://config` (итоговый конфиг), `oc-pilot://rules` (правила проекта с маскировкой секретов), `oc-pilot://prompt/en` и `oc-pilot://prompt/ru` (встроенные системные промпты), `oc-pilot://version`. `oc-pilot://slop` отдаёт Slop Index в JSON без вызова модели. Шаблоны ресурсов дают живые данные: `oc-pilot://diff/{mode}` (staged/unstaged/head diff, секреты замаскированы), `oc-pilot://scan/{mode}` (офлайн-поиск секретов в JSON) и `oc-pilot://file/{+path}` (любой файл проекта до 2 МБ с маскировкой найденных секретов). Клиенты получают списки через `resources/list` и `resources/templates/list`.

Автонастройка клиента:

```bash
oc-pilot setup --client claude --local
oc-pilot setup --client cursor --global
```

ZCode импортирует серверы из Claude Code, Codex, OpenCode и `.agents`, либо пишет нативный конфиг через `oc-pilot setup --client zcode`.

Инструменты: `review`, `invariants`, `test_fix`, `fix`, `test_gen`, `docgen`, `custom`, `scan`, `commit`, `stats`, `slop`, `mutate`, `fuzz`, `bankruptcy`, `query_ast`, `sandbox`, `hivemind_status`, `flaky`, `impact`, `deps`, `coverage`, `reviewers`, `test_guard`, `env_sync`, `mock_leak`, `ecosystem_verify`, `pack`, `pack_hologram`, `zoom_symbol`, `contract_drift`, `anti_regression`, `boundaries`, `test_plan`, `compliance_verify`, `brag`, `battle`, `cleanup`, `arch_diff`, `roast`, `cinema`, `bounty`, `autopsy`, `echo`, `sast`, `authz`, `preflight`, `honeypot`, `alien_dna`, `hyper_chamber`, `butterfly`, `blindfold`, `antibody`, `polygraph`, `skeptic`, `apoptosis`, `scan_injection`, `ready`, `receipt_verify`. У `scan` есть `all: true` — проверка всего репозитория, а не diff. `slop` запускает офлайн Slop Index и принимает `since`, `since_days`, `limit`, `exclude` и `no_blame`. `mutate` прогоняет мутационное тестирование по изменённому коду, принимает `command`, `max_mutants` и `min_score` и возвращает оценку и всех выживших мутантов; оценка ниже `min_score` — обычный результат с кодом 1. `flaky` несколько раз запускает тестовую команду и сравнивает результаты отдельных тестов, принимая `runs`, `command`, `fail_on_flaky`, `shuffle` и `seed`; сам он файлы не меняет, но запускает тесты проекта. `impact` показывает, какие объявления diff изменил или удалил и в каких нетронутых файлах эти имена ещё встречаются; принимает те же флаги источника, а поиск текстовый, поэтому совпадения в комментариях и строках возможны. `deps` проверяет объявленные, импортируемые и залоченные зависимости, `why` объясняет цепочку, `audit` добавляет уязвимости OSV и лицензии, `fix` правит `package.json`, а `sbom` пишет CycloneDX; `fix` и `sbom` пишут файлы и требуют `--allow-write`. `coverage` сверяет изменённые строки с локальным отчётом lcov, Istanbul, Cobertura или Go и возвращает непокрытые строки, файлы без данных и гейт по `fail_under` или `max_uncovered`. `reviewers` ранжирует авторов, которые трогали изменённые файлы, показывает владельцев из CODEOWNERS и принимает `limit`, `depth` и `exclude`; используется только история git. `test_guard` запускает офлайн-проверку на ослабление тестов: пропущенные, сфокусированные или удалённые тесты, удалённые и закомментированные проверки, поднятые таймауты, строгие матчеры, заменённые проверкой существования, `@ts-ignore` и пустые catch; с `fail_on_weakening` находка даёт код 1. `env_sync` сверяет переменные окружения, добавленные diff (`process.env`, `import.meta.env`, `Deno.env`, `Bun.env`), с локальными `.env` и `.env.example`/`.sample`/`.template`: отсутствие определения даёт fail с `fail_on_missing`, а определённые, но не задокументированные переменные — warn. `mock_leak` ищет забытые заглушки и хардкод в добавленном прод-коде: локальные пути, тестовые токены, `if (true)`/`if (false)`, имена mock/fake/stub, комментарии про заглушки и localhost-адреса; `fail_on_leak` даёт код 1 на выбранном уровне. `ecosystem_verify` проверяет, что именованные импорты из изменённых файлов существуют в установленном пакете или его `.d.ts`, и ищет пакеты, которых нет ни в `node_modules`, ни в `package.json`; с `online` дополнительно смотрит возраст и недельные загрузки новых npm-пакетов, а `fail_on_issue` даёт код 1 на выбранном уровне. `pack` собирает компактный контекст задачи: правила проекта, подписи изменённых файлов, связанные ссылки и необязательный лог тестов, с ограничением `budget` в символах; файлы не меняет. `contract_drift` сравнивает изменённые TypeScript-интерфейсы, Zod-объекты, Prisma-модели, Pydantic-модели и JSON Schema с предыдущей версией, находит удалённые поля, ставшие обязательными поля и смену типов и показывает нетронутые файлы, где удалённое поле ещё используется; `fail_on_drift` даёт код 1 на выбранной строгости. `anti_regression` сравнивает строки, добавленные diff, со строками, которые человек явно удалил в истории git, указывает коммит-удаление и ловит повторно добавленный код или импорты; `fail_on_regression` даёт код 1. `boundaries` проверяет добавленные импорты по правилам слоёв из `.oc-pilot/architecture.json`, показывает файл, строку, импорт и причину правила, а `fail_on_violation` даёт код 1 при пересечении границы слоя. `test_plan` выбирает тестовые файлы, затронутые diff, по статическому графу импортов: изменённые тесты, прямые и транзитивные импортёры, совпадения по имени и ссылки на символы; непокрытые изменённые файлы попадают в отчёт, а `fail_on_uncovered` даёт код 1. `compliance_verify` проверяет подписанный аудит-манифест текущего коммита: SHA-256, коммит, цепочку хешей предыдущих манифестов и необязательную подпись Ed25519; отсутствующий, изменённый или разорванный манифест — обычный результат с кодом 1. `test_gen` просит модель написать тесты на изменённый код; с `apply` он пишет файлы, прогоняет тесты и откатывает падения, если не указан `keep_failing`; `coverage` сужает генерацию до непокрытых изменённых строк, а `from_slop` выбирает файлы без тестов. `brag` собирает самодостаточный HTML/SVG-отчёт о сессии из статистики, истории git, последнего ревью и квитанции; только встроенные ресурсы, без модели и сети, `no_paths` скрывает пути. `battle` запускает экспериментальный цикл Coder/Hacker: кодер предлагает патч, хакер делает ревью и прогоняет SAST, авторизацию и проверку ослабления тестов, а цикл останавливается только когда high-находок нет и тесты проходят; `apply` требует `--allow-write`. `cleanup` собирает офлайн-план уборки из проблем зависимостей, Slop Index, переменных окружения и ослабленных тестов; `apply` выполняет только безопасные исправления зависимостей и требует `--allow-write`. `arch_diff` рисует Mermaid-схему внутренних импортов, которые diff добавил или удалил: зелёные стрелки — новые зависимости, красные пунктирные — удалённые, а `fail_on_removed` даёт код 1, когда зависимость исчезла. `roast` превращает diff в технически обоснованную прожарку в выбранной роли (linus, ramsay, corporate или default), ссылается на file:line для каждой шутки и заканчивает одним реальным фиксом; вызывает модель и не меняет файлы. `cinema` собирает терминальный таймлапс сессии из коммитов, запусков, вызовов API, последнего ревью и квитанции: самодостаточный HTML-плеер или asciinema v2 cast, без сети, внешних ресурсов и вызова модели; `no_paths` скрывает темы коммитов и места находок. `bounty` оценивает каждый файл по находкам SAST, дубликатам, мёртвым экспортам, старым TODO и churn без тестов и рисует ASCII-плакат WANTED с худшим файлом и причинами; детерминированно и офлайн. `autopsy` разбирает коммит как детектив: статистика diff, SAST по добавленным строкам, ослабленные тесты, утечки заглушек, рейтинг подозреваемых и хронология до/после; `fail_on_risk` даёт код 1 при опасном вердикте. `echo` собирает самодостаточные SVG-бейджи из локальной статистики, истории git и квитанции (коммиты, запуски агента, вызовы API, попадания в кеш, находки и статус тестов); `submit` отправляет на явный `endpoint` только ник, окно и агрегаты, без путей, diff и секретов, а по умолчанию сети нет. `sast` запускает детерминированный статический анализ по изменению или по явным `paths` и принимает `fail_on_issue`, `ignore` и `no_suppressions`; находка на уровне порога или выше — обычный результат с кодом 1. `authz` проверяет авторизацию маршрутов по изменению или явным `paths` и принимает `fail_on_issue`, `ignore`, `public` и `no_suppressions`; находка маршрута на уровне порога или выше — тоже обычный результат с кодом 1. `preflight` возвращает один офлайн-вердикт по планируемому изменению и принимает те же флаги источника (`diff`, `base`, `staged`, `unstaged`, `include_untracked`), плюс `since`, `max_delta`, `fail_on_issue`, `no_secret_scan`, `no_sast`, `no_authz`, `no_deps`, `no_tests` и `no_slop`; проваленная проверка — обычный результат со `status: "fail"` и кодом 1, а не ошибка инструмента, чтобы агент видел, какая именно проверка упала. `ready` возвращает офлайн-оценку готовности 0–100 и принимает `fail_under`; оценка ниже порога — тоже обычный результат с кодом 1. `receipt_verify` пересчитывает SHA-256 квитанции, сверяет записанный коммит с HEAD и возвращает `ok`, `hashOk` и `stale`; отсутствующая, изменённая или устаревшая квитанция — обычный результат с `ok: false` и кодом 1, чтобы агент видел, почему доказательство не прошло. Инструмент `fix` принимает `from_sast` и `from_authz`, чтобы чинить находки безопасности и пересканировать; результат тогда содержит `sast` или `authz` с `{before, after, remaining}`. Сервер по умолчанию read-only: `--allow-write` разрешает `fix` с `apply: true`, `commit` с `apply: true`, `test_fix` с командой, `stats` с `clear: true` и `mutate`, который временно перезаписывает исходники. Результат `fix` содержит unified-патч, список `files` и `patchStats` (`additions`, `deletions`, `hunks`, `bytes`); патчи длиннее 200 000 символов обрезаются с флагами `patchTruncated` и `patchBytes`, чтобы хост мог показать или применить изменение, не разбирая diff заново.

`invariants` проверяет diff против `.oc-pilot/invariants.md`

`hivemind` — шифрованная TCP-сеть для обмена аналитической работой: `init` создаёт ed25519 identity, `trust` закрепляет публичный ключ узла, `serve` принимает подписанный ECDH X25519 handshake, а `send` передаёт AES-256-GCM payload. Разрешены только diff, AST и LLM-запросы; исполняемые payload отклоняются, а недоверенные узлы отбрасываются до чтения данных.

`sandbox run <file>` исполняет один самодостаточный JavaScript или ESM-файл в `node:vm` с отдельным контекстом: статические импорты, `require`, `fetch`, `process.exit` и таймеры длиннее секунды блокируются, вывод console перехватывается, а исполнение ограничено `--timeout` и `--memory-limit`. TypeScript запускается только из собранного `dist/*.js`. Это не ОС-песочница для нативного кода.

`honeypot deploy` размещает файлы-приманки — `.env.backup` с фальшивыми AWS-ключами, `src/utils/legacy/bypassAuth.ts` с ловушкой `bypassAuth` и `src/legacy/legacy_db_drop.ts` — и записывает их в `.oc-pilot/honeypot.json`. `preflight` падает с `[HONEYPOT TRIGGERED]: Agent attempted to bypass authentication using a trapped function. Session terminated. Trust score reduced.`, если diff импортирует, читает или меняет приманку. `honeypot status` показывает ловушки, `honeypot remove` удаляет только файлы с маркером; это не настоящие секреты.

`alien-dna` сравнивает добавленные строки diff с архитектурной ДНК репозитория на HEAD и падает с `[ALIEN DNA DETECTED]`, если изменение впервые приносит паттерн, которого раньше не было (0% вхождений): Singleton, Proxy, динамический RegExp, eval, глобальное состояние, наследование, декораторы, Worker, EventEmitter, динамический import, синхронный I/O или мутация prototype. Команда офлайн и детерминирована, читает базу через git и не вызывает модель.

`hyper-chamber run <file>` проживает один самодостаточный JavaScript или ESM-файл в `node:vm`: подменяет `Date.now`, ускоряет таймеры, вызывает GC и снимает heap через `node:v8`, симулируя до года работы за короткий реальный бюджет. Устойчивый рост даёт `[MEMORY LEAK DETECTED]: AI code survives Day 1, but crashes on Day N of simulated uptime.` Файл должен экспортировать `run`, `tick`, `main` или `default`; обычный скрипт оборачивается в функцию и вызывается повторно. Это детерминированная эвристика, а не доказательство; нативный код не поддерживается.
`butterfly` запускает тестовую команду проекта в детерминированном локальном хаосе: `fetch` может вернуть HTTP 500, добавить задержку или битый JSON, а `fs` — `EIO` для кода в пределах `--scope` (по умолчанию `src/`). Он показывает число внедрённых сбоев, код выхода и хвост вывода; тест-раннер и `node_modules` исключены фильтром по стеку, а патчи драйверов БД — best-effort. Это помощник для тестов, а не ОС-песочница.

`blindfold` обезличивает идентификаторы (`calculateDiscount(user)` превращается в `fn_A(var_B)`) и отправляет модели только очищенный код, требуя строгий JSON-вердикт. Он падает с `[BLINDFOLD REJECTED]`, если модель не может объяснить логику, находит уязвимость или уверенность ниже `--min-confidence`; `--dry-run` печатает карту замен без вызова модели. Это слепая проверка, а не математическое доказательство.

`antibody` учится на находках безопасности: `antibody learn` сканирует репозиторий офлайн-SAST и сохраняет каждую находку как сигнатуру (правило плюс нормализованный фрагмент кода) в `.oc-pilot/antibodies.json`; `antibody scan` проверяет добавленные строки diff по этим сигнатурам и падает с `[ANTIBODY MATCH]`, когда возвращается известный плохой паттерн. `antibody list`, `forget` и `clear` управляют хранилищем. Это память о прошлых находках, а не замена полному SAST-ревью.

`polygraph` сверяет рассказ с кодом: извлекает фактические утверждения из сообщения коммита или PR и проверяет каждое по diff. Для `test-added`, `file-added`, `file-removed`, `api-change`, `dependency`, `docs`, `security`, `behavior` и `refactor` есть детерминированная проверка; `supported` означает согласованность с diff, `contradicted` — сообщение обещает то, чего в diff нет, а `unverifiable` — diff не позволяет это решить. `[CLAIM CONTRADICTED]` возвращает код 1, а `--strict` падает и на unverifiable. Он читает сообщение, а не намерения автора.

`skeptic` просит модель написать минимальный исполняемый тест, который должен упасть на diff, применяет diff в настоящем shadow worktree и запускает тест и на diff, и на чистом HEAD. `bug` — тест падает на diff и проходит на HEAD; `clean` — гипотеза отклонена; `unfalsifiable` — тест не различает деревья. Прошедший тест не доказывает отсутствие багов.

`apoptosis` сканирует функции с маркером `/* @lifespan: 30d */`. Если маркер старше срока и на символ больше нет ссылок, он показывает `[Senescent]`; `apoptosis apply --confirm` комментирует такие функции в отдельном git worktree, запускает тестовую команду и переносит diff только при зелёном прогоне. Неудачный прогон оставляет рабочее дерево нетронутым. Это уборка AI-кода, а не гарантия, что функция не используется во время выполнения.

`injection` сканирует текст, который может прочитать агент — README, docs, комментарии, HTML, JSON, YAML и исходники — на prompt-injection, перехват роли, exfiltration секретов, невидимый unicode, CSS-спрятанные инструкции, подозрительные markdown-картинки и base64-пейлоады. `--fail-on` задаёт порог exit 1, `--fix` удаляет невидимые символы, а `--include`/`--exclude` сужают область. Это эвристический файрвол, а не доказательство безопасности контента.

`query` выполняет цепочный AQL-запрос к облегчённому графу кода: `find(File|Function|Class|Import|CallExpression).where(field, value).sort(field).limit(n).select(fields...).count()`. Это не SQL и не полный TypeScript AST, а быстрый текстовый граф, который агент может опросить перед правкой. В MCP он доступен как `query_ast`.

`bankruptcy` прогнозирует техдолг по истории коммитов: оценивает каждый коммит по ослабленным тестам, SAST high/medium, добавленным TODO, churn и slop-прокси, сглаживает дневной ряд скользящим средним за 14 дней, выбрасывает выбросы и строит линейную регрессию. На выходе — текущий балл, скорость, дата прогноза и самодостаточный SVG-график; меньше 10 коммитов даёт `[INSUFFICIENT DATA: Need at least 10 commits to compute Slop Velocity]`. `--explain` печатает точные веса, где доминируют ослабленные тесты (0.35) и безопасность (0.30).

`fix --shadow` и `battle --shadow` выполняют применённый патч внутри `.oc-pilot/shadow-tree` — отдельного git worktree, поэтому тесты и внешние компиляторы видят изменённые файлы. Diff извлекается через `git diff` и применяется к рабочему дереву только при успехе; неудачный прогон оставляет диск нетронутым. `--shadow` требует `--apply`.

`fuzz` находит новые экспортируемые функции в diff и вызывает их с null, undefined, -1, 0, пустой строкой, строкой на 10 МБ, объектом `__proto__` и пустыми контейнерами. Каждая цель запускается в отдельном процессе Node с жёстким таймаутом 2 с, настраиваемым лимитом кучи и заглушками fs/net/http/child_process; файлы с импортом побочных модулей блокируются до запуска, а падение или таймаут показываются вместе с конкретным входом. Модель не вызывается.: область `## area` ограничивает правила, `[CRITICAL]` делает правило блокирующим, а правила, чья область не пересекается с изменёнными файлами и их импортёрами, получают `[SKIPPED: Out of scope]` без вызова модели. Модель отвечает строгим JSON, вердикты кешируются по хешу diff и файла инвариантов, а нарушения по умолчанию остаются предупреждениями. Нарушение CRITICAL или `--strict` / `--fail-on violation` даёт код 3. `preflight --invariants` добавляет ту же проверку к гейту.

`pack --hologram` собирает слоистый контекст вместо дампа репозитория: LOD 0 оставляет файлы из diff целиком, LOD 1 скрывает тела функций за маркерами `body hidden` с подсказками `EFFECTS` и добавляет подходящие тесты, LOD 2 показывает только имена экспортов. При несбалансированных скобках файл отдаётся целиком с `[Hologram: parse bailout]`, а итоговый Markdown проходит проверку секретов. `zoom-symbol <file> <symbol>` возвращает скрытое тело по запросу; `pack_hologram` и `zoom_symbol` дают тот же сценарий через MCP.

Каждый инструмент принимает `max_findings` (по умолчанию 50; урезанный результат дополнительно содержит `truncated` и `totalFindings`) и `verbosity` (`full` отдаёт JSON, `compact` — одну строку сводки, а те же данные остаются в `structuredContent`). Если клиент передал `_meta.progressToken`, сервер шлёт `notifications/progress`; после `logging/setLevel` — ещё и `notifications/message` на каждый вызов. `--max-calls <n>` (или `OC_PILOT_MCP_MAX_CALLS`) ограничивает число вызовов с моделью за сессию, `0` снимает лимит, а офлайн-инструменты `scan`, `fuzz`, `bankruptcy`, `query_ast`, `sandbox`, `hivemind_status`, `stats`, `slop`, `flaky`, `impact`, `deps`, `coverage`, `reviewers`, `test_guard`, `env_sync`, `mock_leak`, `ecosystem_verify`, `pack`, `pack_hologram`, `zoom_symbol`, `contract_drift`, `anti_regression`, `boundaries`, `test_plan`, `compliance_verify`, `brag`, `cleanup`, `arch_diff`, `roast`, `cinema`, `bounty`, `autopsy`, `echo`, `sast`, `authz`, `preflight`, `honeypot`, `alien_dna`, `hyper_chamber`, `butterfly`, `apoptosis`, `scan_injection`, `ready` и `receipt_verify` работают и после исчерпания бюджета.

Готовые промпты отдаются через `prompts/list` и рендерятся `prompts/get`, чтобы клиент мог показать их в своём меню: `review-my-diff` (необязательный `context`), `fix-failing-tests` (необязательный `log`), `pre-commit-gate` (scan, review и commit одним проходом), `secure-change` (ревью с фокусом на безопасность), `slop-check` (проверка энтропии вайб-кода) и `preflight-before-commit` (прогнать офлайн-гейт, починить самую дешёвую упавшую проверку и повторять до вердикта pass), `deploy-honeypot` (развернуть файлы-приманки, прогнать preflight, остановиться на `[HONEYPOT TRIGGERED]` и удалить приманки после проверки), `check-alien-dna` (сравнить diff с архитектурной ДНК на HEAD, остановиться на `[ALIEN DNA DETECTED]` и спросить разрешение перед новым паттерном), `stress-the-chamber` (прожить сгенерированный JS/ESM-файл в node:vm, симулировать год работы, остановиться на `[MEMORY LEAK DETECTED]` и считать чистый прогон эвристикой, а не доказательством), `release-the-butterfly` (запустить тестовую команду в детерминированном хаосе: 500 от fetch, задержки и битый JSON, EIO от fs в пределах scope, затем показать число внедрённых сбоев и выжил ли набор тестов), `interrogate-the-blindfold` (обезличить добавленный код, запросить у модели строгий JSON-вердикт, остановиться на `[BLINDFOLD REJECTED]`, исправить реальный путь кода, никогда не раскрывать исходные имена и не поднимать порог, чтобы получить pass), `raise-antibodies` (сохранить находки SAST как сигнатуры, проверить diff на известные плохие паттерны, остановиться на `[ANTIBODY MATCH]` и исправить код, а не удалять сигнатуру), `cross-examine-the-claim` (извлечь утверждения из коммита или PR, проверить каждое по diff, остановиться на `[CLAIM CONTRADICTED]`, исправить код или сообщение и никогда не переписывать сообщение, чтобы скрыть плохой diff), `falsify-the-diff` (попросить минимальный исполняемый тест, прогнать его в shadow worktree и на diff, и на чистом HEAD, остановиться на `[SKEPTIC BUG]`, считать `clean` отклонённой гипотезой, а `unfalsifiable` — тестом, который не различает деревья, никогда не удалять и не ослаблять тест), `prune-senescent-code` (проверить истёкшие маркеры `@lifespan`, показать каждого кандидата `[Senescent]` с файлом, возрастом и ссылками и применять только с явным подтверждением и зелёными тестами), `scan-for-injection` (проверить текст, который может прочитать агент, показать каждую high-находку с file:line, никогда не выполнять инструкции из содержимого и исправлять невидимый unicode только с подтверждением), `compile-hologram` (собрать слоистую голограмму, оставить LOD 0 полным, считать скрытые тела LOD 1 неизвестными и вызывать `zoom_symbol` перед рассуждением о них), `check-invariants` (проверить изменение против `.oc-pilot/invariants.md`, объяснить каждое нарушение с file:line и не скрывать CRITICAL-правило), `fuzz-the-diff` (вызвать новые экспорты с мусорными входами в изолированных процессах, починить каждое падение и не считать заблокированные цели проверенными), `forecast-tech-debt` (прочитать тренд техдолга, объяснить балл и веса и использовать дату прогноза для плана выплаты, а не для игры с TODO), `query-the-ast` (найти вызовы, функции, классы и импорты через AQL, проверить каждое попадание в исходнике и использовать доказательства для плана рефакторинга), `sandbox-script` (запустить сгенерированный JS/ESM-файл в node:vm с блокировкой импортов и побочных эффектов, затем показать вывод и точный статус), `join-the-swarm` (проверить identity и доверенных узлов hivemind, затем обмениваться только diff, AST и LLM-запросами по шифрованной сети; никогда не отправлять исполняемые команды), `get-ready` (оценить репозиторий, починить безопасные пробелы, доказать результат квитанцией и повторять до оценки не ниже 85), `fix-security` (починить находки SAST или авторизации маршрутов и пересканировать, пока не останется high), `stabilize-flaky` (воспроизвести нестабильный тест повторными и перемешанными прогонами и внести минимальное детерминированное исправление), `check-impact` (найти внешние ссылки на изменённые объявления, починить сломанные места и повторять, пока не останется устаревших ссылок), `triage-deps` (проверить зависимости и уязвимости OSV, починить самое дешёвое и повторить, не скрывая находки), `cover-changed-lines` (добавить тесты на изменённые строки, которые не выполнил ни один тест, и повторить тот же гейт), `generate-tests` (сгенерировать тесты на изменение или его непокрытые строки, применить, прогнать и повторять до зелёного), `pick-reviewers` (выбрать минимальный набор ревьюеров, которые знают изменённые файлы, с доказательствами из истории и CODEOWNERS), `guard-tests` (найти тесты, которые изменение пропустило, ослабило или удалило, вернуть им защиту и повторять до прохождения гейта), `sync-env` (сверить переменные окружения, добавленные изменением, с `.env` и `.env.example`, добавить недостающие определения и задокументировать их, не выдумывая секреты), `remove-mocks` (найти забытые заглушки, локальные пути, тестовые токены и всегда истинные условия в прод-коде, заменить их реальной реализацией и повторять до чистого отчёта), `verify-ecosystem` (проверить, что импорты существуют в установленных пакетах, а новые npm-пакеты не появились вчера с парой загрузок, и не ставить подозрительный пакет без решения человека), `pack-context` (собрать компактный контекст задачи из правил, подписей, ссылок и лога тестов и использовать его вместо вываливания целых файлов), `check-contracts` (найти удалённые или суженные поля в изменённых типах и схемах, обновить всех оставшихся потребителей, не ломая их молча), `guard-regressions` (сравнить добавленные строки с кодом, который человек удалил, изучить коммит-удаление и не возвращать его без явного решения), `respect-boundaries` (проверить добавленные импорты по правилам слоёв, исправить направление зависимости и повторять, пока ни одна граница не пересечена), `plan-tests` (прогнать план затронутых тестов, запустить только их, добавить тест на каждый непокрытый изменённый файл и повторить, не расширяя стратегию), `prove-compliance` (проверить подписанный аудит-манифест для HEAD, цепочку хешей и подпись и не заявлять о готовности, пока манифест недействителен), `cleanup-plan` (собрать офлайн-план уборки и применить только безопасные исправления зависимостей), `show-arch-diff` (нарисовать Mermaid-схему добавленных и удалённых внутренних импортов), `roast-my-code` (прожарить diff в выбранной персоне, с file:line и одним реальным исправлением), `play-session` (собрать терминальный таймлапс сессии в виде самодостаточного HTML-плеера или asciinema cast), `wanted-poster` (нарисовать плакат WANTED для худшего файла, объяснить причины и самое весомое исправление и повторить после исправления), `autopsy-commit` (разобрать коммит, перечислить сигналы, ранжировать подозреваемых, прочитать хронологию до/после и предложить минимальное исправление и тест, который поймал бы проблему), `share-progress` (собрать локальные SVG-бейджи и только с явного разрешения отправить анонимные агрегаты на указанный endpoint), `prove-tests` (прогнать мутационное тестирование по изменению и усилить тесты, пока mutation score не достигнет 80) и `prove-done` (проверить квитанцию для HEAD, создать свежую, если её нет или она устарела, и не заявлять о готовности, пока `ok` не равен true, а тесты в квитанции не пройдены).

Запуск вручную:

```bash
oc-pilot-mcp --cwd "C:\path\to\project"
# версия зафиксирована для воспроизводимости:
npx -y oc-pilot@0.98.0 mcp --cwd "C:\path\to\project"
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

MCP по умолчанию **read-only** и для stdio, и для HTTP: `fix` с `apply:true`, `test_fix`, запускающий новую команду, и `deps` с `fix: true` или `sbom`, а также `test_gen` с `apply: true` отклоняются. Для доверенного локального клиента или аутентифицированного окружения добавьте `--allow-write` (в `setup` — `oc-pilot setup --allow-write`) или `OC_PILOT_MCP_READ_ONLY=false`.

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
      - uses: MyNameIsNikki/oc-pilot@v0.98.0
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

Каждый релиз публикуется из тега workflow самого репозитория (OIDC trusted publishing с provenance-аттестацией; секрет `NPM_TOKEN` включает запасной путь через granular-токен npm), а тело GitHub Release берётся из соответствующего раздела `CHANGELOG.md`. CI гоняет тесты на Node 22 и 24 и печатает информационную таблицу покрытия через `node --test --experimental-test-coverage` — без порога, чтобы шумный сигнал не блокировал мерж.

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

### Регрессионные тесты

Три уровня защищают контракты, которые видит модель:

- `test/golden/` фиксирует собранный INPUT для заданных diff: порядок секций, обработка пустых значений и redaction секретов меняются только осознанно. Пересобрать: `OC_PILOT_UPDATE_GOLDEN=1 npm test`, затем прочитать diff перед коммитом.
- `test/fixtures/model-output/` — реалистичные ответы моделей; `src/core/output-format.test.ts` проверяет, какие severity, локации и текст CLI из них извлекает.
- `normalizeLocation` приводит форматы локаций, которые реально пишут модели (`a.ts:10-14`, `a.ts:10,12`, `a.ts#L12`, `a.ts (line 10)` → `a.ts:10`), а списки внутри code fence при разборе игнорируются.

## Лицензия

MIT. См. [LICENSE](LICENSE).

## Поставьте звезду, если хотите писать AI-код без страха

- ⭐ [Поставить звезду oc-pilot](https://github.com/MyNameIsNikki/oc-pilot)
- 🤝 [Участвовать](CONTRIBUTING.md)
- 🐛 [Сообщить о баге](https://github.com/MyNameIsNikki/oc-pilot/issues)
- 📦 [Установить из npm](https://www.npmjs.com/package/oc-pilot)
