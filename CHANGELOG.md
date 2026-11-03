# Changelog

## 0.12.0

- Retry с backoff для движков: ответы 408, 425, 429, 500, 502, 503 и 504 повторяются до трёх раз с экспоненциальной задержкой (500 мс, 1 с, 2 с, потолок 8 с), заголовок `Retry-After` учитывается. Сетевые ошибки и таймауты по-прежнему падают сразу. Настройки — `retryAttempts` и `retryDelayMs` в вызове движка.
- Параллельные слайсы: разрезанный diff уходит в модель до трёх запросов одновременно, ответы собираются в исходном порядке, поэтому `mergeSliceAnalyses` даёт тот же результат, что и раньше, но быстрее. Длинный дифф на движке `openai` перестаёт быть узким местом.
- Детектор ослабления тестов: пропущенные и сфокусированные тесты (`it.skip`, `xit`, `.only`, `t.Skip`, `pytest.mark.skip`, `#[ignore]`), удалённые проверки без замены, закомментированные ассерты и поднятый до 10 секунд и выше `setTimeout`. `review` предупреждает и добавляет блок `TEST_WEAKENING` в промпт, `--no-test-weakening` превращает находки в exit 3.
- `oc-pilot impact`: показывает, где ещё используется изменённый в диффе символ. Текстовый поиск по tracked и untracked файлам без AST, есть `--json` для агентов и CI.
- `oc-pilot scan --all`: сканирует всё дерево репозитория, а не только дифф, с учётом `.gitignore` и `.oc-pilot/ignore`. Бинарники, файлы больше 512 КБ и каталоги `node_modules`/`dist` пропускаются.
- 247 тестов; версия 0.12.0.

## 0.11.1

- Пять новых Agent Skills в `skills/`: `agent-self-review` (цикл перед коммитом: скан, ревью, фикс, повторная проверка), `test-failure-triage` (лог падения → первопричина → патч со снимком → прогон), `secure-diff-gate` (секреты, security-пресет, second opinion, признаки инъекций, SARIF), `commit-discipline` (conventional commit по staged-diff с блокировкой при секретах) и `stack-review-packs` (комбинируемые наборы правил). Базовый `oc-pilot` получил секцию `## Related skills`.
- Тест `src/skills.test.ts` проверяет каждый скилл: frontmatter, имя каталога, длину описания, реальные команды и флаги CLI, отсутствие заглушек.
- 228 тестов; версия 0.11.1.

## 0.11.0

- Second opinion: `review --second-opinion` (engine=openai) прогоняет до 10 критичных находок через вторую скептическую модель (`--second-opinion-model` / `--second-opinion-base-url` / `--second-opinion-api-key-env`, конфиг `secondOpinionEnabled` и др.). `VERDICT: REJECT` понижает находку с critical до style с пометкой `[second opinion: rejected — причина]`; ошибка верификатора оставляет находки как есть. Итог — в `meta.secondOpinion`.
- Dependency gate: `review` автоматически разбирает новые зависимости в 8 манифестах (npm, pypi, go, cargo, rubygems, packagist, maven/gradle, nuget) — тайпосквоты (`lodahs` рядом с популярными пакетами), незакреплённые версии (`""`, `*`, `latest`), VCS/URL-спеки. Предупреждение `DEPENDENCY_CHANGES` уходит в промпт, счётчик — в `meta.dependencies`.
- Test delta: логика изменена (≥ 20 добавленных строк в кодовых файлах) без тестов — предупреждение `TEST_COVERAGE_HINT`; `review --require-tests` превращает его в exit-код 3.
- `oc-pilot stats`: запуски, API-вызовы, попадания кеша, средняя длительность и находки за сегодня / неделю / всё время (`.git/oc-pilot/stats.jsonl`, `--clear`).
- `oc-pilot day`: сводка активности за период (`--since "1 day ago"`) — коммиты, файлы по churn, строки +/- и находки oc-pilot.
- Дневной лимит API-вызовов: `maxDailyApiCalls` / `OC_PILOT_MAX_DAILY_API_CALLS` (0 — без лимита); при исчерпании exit 1, попадания кеша не расходуют лимит.
- PR-комментарии без gh: внутри GitHub Actions `review --pr` постит сводку через REST API с `GITHUB_TOKEN` (нужна permission `pull-requests: write`); локально — как раньше через `gh`.
- Agent-rules: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules`, `.github/copilot-instructions.md` автоматически попадают в промпт (до 10 000 символов, секреты маскируются); отключается `agentRules: false`.
- Пресеты `flutter`, `elixir`, `zig`, `scala` — всего 23.
- `review --interactive`: по находке спрашивает «Скрыть в baseline? [y/N]», выбранные дописываются в `.oc-pilot/baseline.json` (TTY-only).
- Эвристики prompt injection: 6 паттернов (переопределение инструкций, role-hijack, эксфильтрация промпта, base64-блобы, невидимый Unicode) в добавленных строках — предупреждение `PROMPT_INJECTION_RISKS` и `meta.injection`.
- 225 тестов; версия 0.11.0.

## 0.10.0

- Пресеты правил для новых стеков: к `base`, `node`, `react`, `python`, `go` добавлены `next`, `vue`, `svelte`, `angular`, `typescript`, `rust`, `java`, `kotlin`, `csharp`, `swift`, `php`, `ruby` плюс сквозные `security` (инъекции, авторизация, крипто, утечки) и `devops` (Dockerfile, CI-workflow, Terraform/K8s). Всего 19 пресетов.
- Комбинации пресетов: `oc-pilot init --preset react,security` склеивает несколько пресетов в один `.oc-pilot/rules.md` (общая шапка, секции разделены линиями); неизвестный пресет в списке ломает всю команду с подсказкой доступных.
- 195 тестов; версия 0.10.0.

## 0.9.0

- Кеш ответов для `--engine openai`: повторный запрос с тем же промптом и моделью берётся из локального кеша в `.git/oc-pilot/cache/` — ноль токенов. Ключ — `sha256(model + base URL + system prompt + input)`, TTL по умолчанию 24 часа (`cacheTtlSeconds` / `OC_PILOT_CACHE_TTL`, `0` отключает), `--no-cache` обходит кеш на один запуск. Кешируются триаж роутера, основной вызов и слайсы; opencode-движок не кешируется. Новая команда `oc-pilot cache` (`--stats` / `--prune` / `--clear`); попадание видно в `meta.cache` (`hit` / `miss`). Ошибка кеша никогда не ломает ревью.
- Baseline известных находок: `review --baseline` прячет находки из `.oc-pilot/baseline.json` — из exit-кода, текстового вывода, `--json`, SARIF и PR-комментария. Отпечаток — `severity | файл | нормализованный текст` без номера строки, поэтому переживает сдвиги кода; `--update-baseline` перезаписывает файл и выходит с кодом 0; счётчики — в `meta.baseline` (`known`, `total`).
- Пресеты правил: `oc-pilot init --preset base|node|react|python|go` пишет готовый `.oc-pilot/rules.md` под стек проекта; файл можно свободно дополнять.
- `oc-pilot doctor --fix`: обновляет устаревшие oc-pilot-хуки (с бэкапом), чистит просроченный кеш; чужие хуки не трогает. В отчёт добавлены проверки git-хуков и кеша.
- `.pre-commit-hooks.yaml` в корне репозитория — интеграция с pre-commit framework: хуки `oc-pilot-secrets` (`scan --staged`) и `oc-pilot-review` (`review --staged --fail-on critical --fail-on-secrets`), `language: system`.
- `review --pr` отправляет сводный комментарий в текущий PR через GitHub CLI (`gh pr comment`): до 30 находок, группировка по severity, футер с версией и коммитом.
- 191 тест; версия 0.9.0.

## 0.8.0

- Двухфазный роутинг для `review` с `--engine openai`: перед основным вызовом дешёвая модель-триаж получает те же данные с компактным системным промптом и отвечает строкой `TRIAGE: REVIEW` / `TRIAGE: LGTM`. `LGTM` пропускает основной вызов; ошибка или нечитаемый ответ откатывается к полному ревью (`meta.router` — модель, решение, длительность, флаг fallback). Включается флагом `--router` / `--no-router` / `--router-model <m>`, конфигом `routerEnabled` + `routerModel` или переменными `OC_PILOT_ROUTER` / `OC_PILOT_ROUTER_MODEL`. Блокировка `--fail-on-secrets` работает независимо от роутера.
- Cache-friendly порядок промпта: `SECRET_SCAN` перенесён перед `GIT_DIFF`, изменчивый diff теперь идёт последней секцией. Стабильный префикс (инструкция, тип проекта, рецепт, контекст, отчёт сканера) одинаков между слайсами, раундами fix и повторными ревью — провайдеры с префикс-кэшированием (OpenAI, DeepSeek, Anthropic) переиспользуют его автоматически.
- MCP-ресурсы и шаблоны: `oc-pilot://config`, `oc-pilot://rules`, `oc-pilot://version`, `oc-pilot://prompt/{en|ru}` и шаблоны `oc-pilot://diff/{mode}`, `oc-pilot://scan/{mode}`, `oc-pilot://file/{+path}`; методы `resources/list`, `resources/templates/list`, `resources/read`. Секреты маскируются во всех ресурсах; файлы — только внутри проекта, до 2 МБ, без бинарных.
- 161 тест; версия 0.8.0.

## 0.7.0

- Умный slicing для `--engine openai`: diff больше одного промпта (300 000 символов) не усекается, а разбивается на слайсы по файлам (`planDiffSlices`), на каждый слайс — отдельный вызов API, ответы склеиваются в один анализ по OUTPUT SCHEMA (`mergeSliceAnalyses`); количество вызовов — в `meta.slices`. Файл больше бюджета уходит отдельным слайсом и усекается последним. Работает для `review`, `test-fix`, `custom`; `fix` и `docgen` всегда шлют один промпт.
- Новая команда `oc-pilot commit`: генерирует commit-сообщение в формате Conventional Commits по staged-изменениям (по умолчанию staged), видит последние 10 commit-сообщений проекта. `--apply` коммитит (`git commit -F -`), блокируется при critical-секретах (код `3`), `--allow-secrets` снимает блокировку; `--json` отдаёт структуру. Сообщение очищается от markdown-обёрток и control-символов (`sanitizeCommitMessage`).
- Рецепт `commit` в системном промпте (RU/EN): только сырое commit-сообщение, типы feat/fix/docs/…, subject <= 72 символов в повелительном наклонении; `validateAnalysis` для `commit` не проверяет OUTPUT SCHEMA.
- 153 теста; версия 0.7.0.

## 0.6.0

- `oc-pilot install-hook`: нативные git-хуки pre-commit (`scan --staged`) и опциональный pre-push (`review --fail-on critical --fail-on-secrets`) на чистом POSIX sh, без husky. `--uninstall`, `--force` (чужой хук сохраняется как `.oc-pilot.bak`), `--pre-push`, разовый пропуск через `OC_PILOT_SKIP=1`; учитывает `core.hooksPath` и worktrees.
- Снимок рабочего дерева перед `fix --apply`: бинарный патч tracked-изменений против HEAD плюс копии untracked-файлов в `.git/oc-pilot/snapshots/<id>/`, ничего не коммитится. Новая команда `oc-pilot restore [id]` (`--list`) откатывает изменения; `fix --no-snapshot` отключает.
- Игнорирование ложных срабатываний сканера секретов: файл `.oc-pilot/ignore` (glob-шаблоны путей, `#`-комментарии) и инлайн-маркер `// oc-pilot:ignore-secret` / `# oc-pilot:ignore-secret` для конкретной строки. Действует во всех точках сканирования: diff, patch в `fix`, полные файлы, правила, docgen.
- Shannon-энтропия: высокоэнтропийные присваивания (длина >= 20, энтропия >= 4 бита) помечаются как critical `High-entropy secret`; само значение маскируется и не попадает в логи, JSON и SARIF.
- `--format sarif` для `scan` и `review`: SARIF 2.1.0 для GitHub Code Scanning, правила `oc-pilot/secret`, `oc-pilot/critical`, `oc-pilot/warning`; `-o results.sarif` пишет файл.
- 135 тестов; версия 0.6.0.

## 0.5.2

- Patch release after the npm registry left `0.5.1` reserved but not published. No runtime code changes.
- Published from the same commit/tag content with a fresh version so npm can publish normally.
- 112 tests; версия 0.5.2.

## 0.5.1

- `setup` теперь поддерживает **ZCode** (Z.ai): project `.zcode/config.json` и global `~/.zcode/cli/config.json`, ключ `mcp.servers`.
- Добавлен универсальный клиент `agents`: project `.agents/mcp.json` и global `~/.agents/mcp.json`, ключ `mcpServers`. Этот формат читает ZCode как fallback и другие MCP-клиенты.
- `doctor` распознаёт ZCode и `.agents` конфиги.
- README EN/RU и `docs/integrations.md` обновлены: Claude Code, DeepSeek Harness, ZCode, `.agents`, generic MCP.
- 112 тестов; версия 0.5.1.

## 0.5.0

- Добавлен движок `openai`: любой OpenAI-совместимый `/chat/completions` (OpenAI, DeepSeek, Groq, OpenRouter, Ollama). OpenCode больше не обязателен.
- Новые флаги `--engine`, `--base-url`, `--api-key-env`; конфиг `engine`, `baseUrl`, `apiKeyEnv`; env `OC_PILOT_ENGINE`, `OC_PILOT_BASE_URL`, `OC_PILOT_API_KEY_ENV`. Ключ читается из `OC_PILOT_API_KEY`/`OPENAI_API_KEY` и не попадает в ошибки.
- Для движка `openai` автоматически включается `FULL_FILE_CONTEXT`, а инструменты репозитория отключаются.
- Добавлена команда `oc-pilot doctor`: проверяет Node, движок, ключ, git, тестовую команду, MCP-конфиги и правила; `--json`, exit 1 при ошибках, `--strict` для предупреждений.
- `oc-pilot setup` без `--client` сам находит установленные Claude Code, Codex, Cursor, Gemini CLI, OpenCode, VS Code и Windsurf.
- Добавлен composite GitHub Action `action.yml` для PR-гейта в три строки.
- README EN/RU и `docs/integrations.md` обновлены: движки, doctor, авто-настройка, Action.
- 111 тестов; версия 0.5.0.

## 0.4.3

- Fixed remote MCP config shapes: Gemini uses `httpUrl`, Windsurf uses `serverUrl`.
- `setup --http --token` for Gemini now stops with an explanation instead of writing a header that Gemini does not expand.
- 103 теста; версия 0.4.3.

## 0.4.2

- `fix` scans only added lines in the proposed patch. A patch that removes a leaked secret is no longer rejected as if it added one.
- `setup` no longer writes the unsupported `enabled` field into OpenCode MCP config; servers are enabled by default in OpenCode V2.
- `setup --http --token` now writes an `OC_PILOT_MCP_TOKEN` reference instead of the secret itself.
- User-journey verification: GitHub install, `scan`, real `review`, `test-fix`, `fix --apply` with tests, MCP stdio, Claude/Codex/OpenCode setup.
- 101 тест; версия 0.4.2.

## 0.4.1

- MCP-сервер теперь **read-only по умолчанию** и для stdio, и для HTTP: `fix` с `apply:true` и `test_fix`, запускающий новую команду, требуют явного `--allow-write`.
- `oc-pilot setup --allow-write` добавляет этот флаг в конфиг клиента; без него агент получает только анализ и предложение патча.
- Уточнены SECURITY.md, README и `docs/integrations.md`: безопасные значения по умолчанию, доверенный локальный клиент, TLS и токен для HTTP.
- 100 тестов; версия 0.4.1.

## 0.4.0

- Добавлена команда `oc-pilot setup` для Claude Code, Codex, Cursor, Gemini CLI и OpenCode: `--local/--global`, `--print`, `--json`, `--http/--token`, сохранение чужих серверов и настроек.
- `oc-pilot-mcp` получил Streamable HTTP транспорт (`--http`, `--host`, `--port`, `--path`, `--token`, `/health`, `Mcp-Session-Id`) для контейнеров и удалённых агентов.
- Добавлена команда `fix`: модель предлагает unified diff, патч проверяется через `git apply --check`, применяется с `--apply`, тесты запускаются автоматически, при падении патч откатывается; `--keep-on-test-failure`, `--no-tests`, `--rounds`.
- MCP-инструмент `fix` с `apply`, `command`, `no_tests`, `rounds`.
- `--github` печатает inline-аннотации GitHub Actions (`::error` / `::warning`) для `review` и `fix`.
- Добавлены `Dockerfile`, `docker-compose.yml`, `.dockerignore`; образ включает OpenCode и запускает HTTP MCP на порту 8787.
- Добавлен Agent Skill `skills/oc-pilot/SKILL.md` и `server.json` для MCP Registry.
- Добавлены `oc-pilot mcp`, read-only HTTP по умолчанию, `--allow-write`, проверка токена и ограничение путей; CI/CodeQL/release workflows, `SECURITY.md`, поддержка DeepSeek Harness.
- `dist` коммитится в репозиторий, поэтому установка из GitHub-тега не требует devDependencies: `npm install -g https://github.com/MyNameIsNikki/oc-pilot/archive/refs/tags/v0.4.0.tar.gz`. Docker runtime использует `--ignore-scripts`.
- Обновлены README, `README.ru.md`, `docs/integrations.md`; 99 тестов.

## 0.3.0

- Английский системный промпт стал языком по умолчанию для глобальной аудитории; добавлены `--lang en|ru`, `OC_PILOT_LANG` и `lang` в конфиге. Русский промпт сохранён.
- Добавлен MCP-сервер `oc-pilot-mcp` (stdio, JSON-RPC 2.0) с инструментами `review`, `test_fix`, `docgen`, `custom`, `scan` для Claude Code, Codex, Cursor, Gemini CLI и OpenCode.
- Добавлена интеграционная документация `docs/integrations.md` и разделы MCP в README.
- README переведён на английский как основной; русская версия — `README.ru.md`.
- Промпты разделены на `prompts/oc-pilot.en.md` и `prompts/oc-pilot.ru.md`; `.opencode/agents/oc-pilot.md` использует английский промпт.
- `--no-secret-scan` теперь также отключает сканирование `PROJECT_RULES` и `FULL_FILE_CONTEXT`.
- Добавлены тесты MCP и двуязычных промптов; версия 0.3.0.

## 0.2.0

- Встроенный агент `oc-pilot` теперь работает с read-only контекстом репозитория: `read`, `glob`, `grep`; изменение файлов, shell, web и внешние директории запрещены.
- Добавлен `--no-repo-context` для изолированного diff-only режима. В нём изменённые файлы передаются как `FULL_FILE_CONTEXT` с redaction.
- Добавлены структурированные `findings` в JSON и флаг `--fail-on critical|warning|style` для CI.
- Добавлены правила проекта `.oc-pilot/rules.md` (автопоиск вверх по дереву, `--rules`, `rules` в конфиге).
- Расширен сканер секретов: Hugging Face, Groq, Discord, SendGrid, DigitalOcean, PyPI, Azure Storage, `.env`-присваивания.
- Новые настройки: `repoContext`, `failOn`, `rules` и переменные `OC_PILOT_REPO_CONTEXT`, `OC_PILOT_FAIL_ON`, `OC_PILOT_RULES`.
- Обновлены README, промпт и конфигурация агента.

## 0.1.0

- Первый релиз: `review`, `test-fix`, `docgen`, `custom`, `scan`, `init`.
