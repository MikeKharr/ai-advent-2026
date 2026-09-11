# [2026-09-07 15:20] Инициализация проекта и каркаса документации

Файл: `agent_docs/development-history/2026-09-07-1520-project-bootstrap.md`

## Что сделано

- Исследованы вводные: инструмент `web_search` в Messages API (версии, параметры, цена $10 за 1000 поисков), актуальный прайсинг моделей, структурированный вывод через `output_config`, тарифы VPS в Сингапуре.
- Согласован план задачи 1: приложение «сфера → 3 главные свежие новости стартапов», Node 22, Vultr Singapore, Caddy, деплой через GitHub Actions.
- Прочитан `2030ai/2030ai-project-template` целиком (31 файл) и `cmit-ru/cmit-starter` как источник memory-слоя.
- Создан каркас репозитория: `AGENTS.md`, `CLAUDE.md`, `README.md`, дотфайлы, `.vscode/settings.json`, два CI-workflow.
- Создан `agent_docs/`: index, glossary, architecture, invariants, snapshot, backlog, backlog-closed, setup-checklist, гайды, шаблоны, коллекции adr и development-history.
- Написаны 10 ролей агентов в `.claude/agents/`.
- Заведены шесть ADR по решениям этой сессии.

### Ограничения песочницы агента, найденные при подготовке

Три ограничения изменили план, поэтому зафиксированы отдельно:

- **npm и PyPI заблокированы** (`403 Forbidden`). Установить зависимости нельзя, код нельзя запустить перед передачей. Следствие — ADR `2026-09-07-1525-zero-dependency-node.md`.
- **Исходящий SSH закрыт.** Провижининг и ручной деплой на VPS невозможны. Следствие — `bootstrap.sh` для владельца плюс деплой через Actions, ADR `2026-09-07-1535-vps-vultr-singapore.md`.
- **Токен GitHub у агента не привязан ни к одному репозиторию** — `POST /user/repos` отвечает «sessions are bound to their configured repositories». Создать репозиторий агент не может, это делает владелец.

### Отклонения от шаблона

- Добавлена конвенция коммитов и веток в `AGENTS.md` — в шаблоне 2030ai её нет, а проект пишет код, а не только документацию.
- Добавлен workflow `docs-guard`: лимит 300 строк для `snapshot.md` и `backlog.md`, проверка имён атомарных документов, поиск утёкшего API-ключа.
- Из workflow `markdownlint` убрано исключение `!skill-andMCPupdater-zvasil/**` — остаток личной папки автора шаблона, к этому проекту отношения не имеет.
- Добавлен гайд `drive-sync` (удалён по ADR `2026-09-11-0513`) — правила витрины в Google Drive, которых в шаблоне нет.

## Зачем

Задать воспроизводимый порядок работы до написания первой строки прикладного кода. Каркас, заведённый после кода, всегда подгоняется под то, что уже случайно получилось; заведённый до — задаёт рамку. Отдельная цель — отработать практики, переносимые в основной проект HBK.SG.

## Обновлено

- [x] `AGENTS.md`
- [x] `README.md`
- [x] `agent_docs/index.md`
- [x] `agent_docs/architecture.md`
- [x] `agent_docs/snapshot.md`
- [x] `agent_docs/backlog.md`, `agent_docs/backlog-closed.md`
- [x] `agent_docs/invariants.md`
- [x] `agent_docs/glossary.md`
- [x] ADR: шесть записей от 2026-09-07
- [ ] Тесты (не применимо — прикладного кода ещё нет)

## Связанные решения

- `agent_docs/adr/2026-09-07-1455-adopt-2030ai-template.md`
- `agent_docs/adr/2026-09-07-1500-docs-language-russian.md`
- `agent_docs/adr/2026-09-07-1510-git-source-of-truth-drive-mirror.md`
- `agent_docs/adr/2026-09-07-1515-full-role-roster.md`
- `agent_docs/adr/2026-09-07-1525-zero-dependency-node.md` (статус: Предложено)
- `agent_docs/adr/2026-09-07-1535-vps-vultr-singapore.md`

## Следующие шаги

- Владельцу: принять или отклонить ADR по стеку — он блокирует начало разработки.
- Владельцу: создать публичный репозиторий, запушить каркас, включить branch protection.
- Спайк контракта `web_search` + строгий JSON до написания UI.
