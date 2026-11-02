# oc-pilot

[English version](README.md)

AI-ассистент разработчика для терминала: ревью git-diff, разбор падающих тестов, генерация документации и офлайн-поиск секретов. Работает поверх [OpenCode](https://opencode.ai) CLI, читает файлы проекта только для контекста и не меняет их. Доступен как MCP-сервер `oc-pilot-mcp` для Claude Code, Codex, Cursor, Gemini CLI, DeepSeek Harness и OpenCode.

```
oc-pilot review          # баги, уязвимости, идиомы языка
oc-pilot test-fix        # первопричина падения тестов + минимальный фикс
oc-pilot docgen src/**   # GoDoc / RustDoc / JSDoc / docstrings
oc-pilot scan            # секреты в diff без вызова модели
```

## Требования

- Node.js **22+**
- OpenCode CLI **2.x** в `PATH` (`opencode --version`)
- Настроенная модель и авторизация OpenCode (`opencode auth list`)
- Для MCP-режима — любой агент с поддержкой MCP (Claude Code, Codex, Cursor, Gemini CLI, DeepSeek Harness, OpenCode)

## Установка

Из GitHub, с фиксацией на теге релиза (работает до первого релиза в npm):

```bash
npm install -g https://github.com/MyNameIsNikki/oc-pilot/archive/refs/tags/v0.4.1.tar.gz
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

oc-pilot init                 # создать .oc-pilot.json (необязательно)
oc-pilot setup --client claude --local  # настроить MCP-клиент
oc-pilot scan                 # офлайн-проверка секретов
oc-pilot review               # diff HEAD (staged + unstaged)
oc-pilot review --staged
oc-pilot review --base main
git diff | oc-pilot review --stdin

oc-pilot test-fix             # разобрать падающий тест
oc-pilot fix --apply --command "npm test"  # патч + тесты
```

`review` только предлагает изменения: он не применяет патчи и не редактирует файлы. Писать в рабочее дерево умеет только `fix --apply`.

## Как это работает

1. `oc-pilot` собирает diff: `git diff HEAD`, `--staged`, `--base <ref>`, файл или stdin.
2. Определяет язык по изменённым файлам и манифестам проекта.
3. Сканирует **добавленные строки** на секреты и заменяет найденные значения маркерами `[REDACTED:<kind>]`.
4. Запускает `opencode run --format json` и передаёт входные данные через stdin (без ограничений длины командной строки Windows).
5. Встроенный агент `oc-pilot` получает настоящий system prompt через `OPENCODE_CONFIG_CONTENT` и `--standalone`. В режиме по умолчанию ему разрешены только `read`, `glob`, `grep`; `edit`, `shell`, `webfetch`, `external_directory` и доступ к `.env`/ключам запрещены. Модель может проверить сигнатуры и вызовы в репозитории, но не изменить файлы.
6. С флагом `--no-repo-context` создаётся изолированный временный проект с агентом без инструментов. В промпт дополнительно попадает `FULL_FILE_CONTEXT` — полные изменённые файлы (до 60 000 символов, секреты редактируются), поэтому модель видит контекст функции даже без доступа к репозиторию.
7. Ответ печатается в stdout как Markdown; диагностика и предупреждения идут в stderr. `--fail-on` превращает найденные замечания в exit code 3 для CI.

Системные промпты лежат в [`prompts/oc-pilot.en.md`](prompts/oc-pilot.en.md), [`prompts/oc-pilot.ru.md`](prompts/oc-pilot.ru.md) и в [`src/core/prompt.ts`](src/core/prompt.ts). Готовая конфигурация агента для OpenCode — [`.opencode/agents/oc-pilot.md`](.opencode/agents/oc-pilot.md).

### Свой агент

По умолчанию используется встроенный `oc-pilot`. Флаг `--agent <name>` переключает на любой существующий агент OpenCode; в этом режиме системный промпт передаётся в сообщении пользователя, а права и инструменты определяются выбранным агентом. Это расширенный режим: провайдер может отфильтровать большой промпт как попытку инъекции, а `--no-repo-context` не сможет отозвать права чужого агента.

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
| `--no-repo-context` | не давать агенту читать файлы (только diff) |
| `--rules <path>` | файл правил проекта |
| `--fail-on <level>` | exit 3 при замечаниях `critical`, `warning` или `style` |
| `--fail-on-secrets` | exit 3 при critical-секретах |
| `--no-secret-scan` | не искать секреты и не редактировать diff |

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

`fix` не делает commit и push. При падении тестов патч откатывается, если не указан `--keep-on-test-failure`. Чужие незакоммиченные изменения не откатываются.

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
git diff main...HEAD | oc-pilot scan --stdin --json
```

Код возврата `1` при critical-находках (или при любых с `--strict`), `0` — чисто, `--no-fail` — всегда `0`.

### `setup`

Настраивает MCP-клиент на запуск `oc-pilot-mcp`, сохраняя чужие серверы и настройки. По умолчанию используется текущая установка (`node dist/mcp.js`); `--npx` записывает `npx -y oc-pilot@<version> mcp`, `--local` принудительно выбирает локальный путь. Сгенерированный сервер read-only; `--allow-write` разрешает агенту применять патчи и запускать тесты.

```bash
oc-pilot setup --client claude --local
oc-pilot setup --client opencode --client cursor --local
oc-pilot setup --client codex --global
oc-pilot setup --client claude --local --print
oc-pilot setup --client claude --local \
  --http https://oc-pilot.example.com/mcp --token "$OC_PILOT_TOKEN"
```

Клиенты: `claude`, `codex`, `cursor`, `gemini`, `opencode`, `vscode`, `windsurf`. Опции: `--all`, `--client` (повторяемый), `--global` (иначе проект), `--local` (абсолютный путь текущей установки), `--npx` (команда `npx` с закреплённой версией), `--allow-write`, `--print`, `--json`, `--http`, `--token`, `--cwd`, `--force`. `setup` меняет только конфиг MCP-клиента и не устанавливает пакеты.

### `init`

```bash
oc-pilot init
oc-pilot init --force
```

Создаёт `.oc-pilot.json` с настройками по умолчанию.

## Конфигурация

`oc-pilot` ищет `.oc-pilot.json` в текущей директории и выше (до 32 уровней). Приоритет: **CLI > переменные окружения > файл > значения по умолчанию**.

```json
{
  "agent": "oc-pilot",
  "model": "anthropic/claude-sonnet-4-5",
  "maxDiffChars": 120000,
  "maxOutputChars": 40000,
  "maxFileChars": 60000,
  "timeoutSeconds": 300,
  "testCommand": "npm test",
  "redactSecrets": true,
  "repoContext": true,
  "failOn": "none"
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

Переменные окружения: `OC_PILOT_MODEL`, `OC_PILOT_AGENT`, `OC_PILOT_MAX_DIFF_CHARS`, `OC_PILOT_MAX_OUTPUT_CHARS`, `OC_PILOT_MAX_FILE_CHARS`, `OC_PILOT_TIMEOUT_SECONDS`, `OC_PILOT_TEST_COMMAND`, `OC_PILOT_REDACT_SECRETS`, `OC_PILOT_REPO_CONTEXT`, `OC_PILOT_FAIL_ON`, `OC_PILOT_RULES`.

## Безопасность

- Сканер ищет AWS/GitHub/GitLab/Slack/Stripe/Google/OpenAI/Anthropic/npm/Hugging Face/Groq/Discord/SendGrid/DigitalOcean/PyPI/Azure-токены, Telegram-бот-токены, JWT, приватные ключи, credentials в URL, generic-присваивания (`password: "..."`) и `.env`-строки (`DB_PASSWORD=...`).
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

`oc-pilot-mcp` — MCP-сервер для Claude Code, Codex, Cursor, Gemini CLI и OpenCode. Он даёт агенту инструменты `review`, `test_fix`, `fix`, `docgen`, `custom`, `scan`, а модель и доступ к репозиторию остаются в вашем CLI.

Автонастройка клиента:

```bash
oc-pilot setup --client claude --local
oc-pilot setup --client cursor --global
```

Запуск вручную:

```bash
oc-pilot-mcp --cwd "C:\path\to\project"
# после релиза в npm, версия зафиксирована:
npx -y oc-pilot@0.4.1 mcp --cwd "C:\path\to\project"
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

Agent Skill для Claude Code/Codex/OpenCode лежит в [`skills/oc-pilot/SKILL.md`](skills/oc-pilot/SKILL.md): он объясняет агенту, когда вызывать `scan`, `review`, `test-fix`, `fix` и `docgen`.

Конфигурации для Codex, Cursor, Gemini CLI и OpenCode, формат результата и CI-примеры — в [docs/integrations.md](docs/integrations.md). Инструменты принимают `diff` и `log` как текст, а `paths` — относительно `--cwd`.

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
