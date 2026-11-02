# Changelog

## 0.4.0

- Добавлена команда `oc-pilot setup` для Claude Code, Codex, Cursor, Gemini CLI и OpenCode: `--local/--global`, `--print`, `--json`, `--http/--token`, сохранение чужих серверов и настроек.
- `oc-pilot-mcp` получил Streamable HTTP транспорт (`--http`, `--host`, `--port`, `--path`, `--token`, `/health`, `Mcp-Session-Id`) для контейнеров и удалённых агентов.
- Добавлена команда `fix`: модель предлагает unified diff, патч проверяется через `git apply --check`, применяется с `--apply`, тесты запускаются автоматически, при падении патч откатывается; `--keep-on-test-failure`, `--no-tests`, `--rounds`.
- MCP-инструмент `fix` с `apply`, `command`, `no_tests`, `rounds`.
- `--github` печатает inline-аннотации GitHub Actions (`::error` / `::warning`) для `review` и `fix`.
- Добавлены `Dockerfile`, `docker-compose.yml`, `.dockerignore`; образ включает OpenCode и запускает HTTP MCP на порту 8787.
- Добавлен Agent Skill `skills/oc-pilot/SKILL.md` и `server.json` для MCP Registry.
- Добавлены `oc-pilot mcp`, read-only HTTP по умолчанию, `--allow-write`, проверка токена и ограничение путей; CI/CodeQL/release workflows, `SECURITY.md`, поддержка DeepSeek Harness.
- Обновлены README, `README.ru.md`, `docs/integrations.md`; 97 тестов.

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
