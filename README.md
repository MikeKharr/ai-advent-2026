# ai-advent-2026

Проект AI Advent 2026: тридцать пять заданий челленджа, пройденных за полтора месяца, и инструменты, которые от них остались.

**Приложения дней сняты 2026-10-20** (`agent_docs/adr/2026-10-20-0737-retire-challenge-days.md`): каталог `days/`, страницы дней на сайте и их контейнеры в проде удалены, живые демо больше не отвечают. Что сделано и чем закончилось — в журнале прогресса на главной и в `agent_docs/` (решения, история, замеры); из кода остались общие части: роутер провайдеров, сервис агентов, служба MCP, индекс проекта на эмбеддингах и два локальных сервера MCP для сессий разработки.

Репозиторий построен на `2030ai/2030ai-project-template` с memory-слоем из `cmit-ru/cmit-starter`.

**Продакшен:** `https://challenge.zpq.ai` — журнал прогресса; `challenge.zpq.ai/mcp` и `challenge.zpq.ai/rag` — две службы за ключом.

## Структура проекта

```text
├── AGENTS.md                 # Универсальные правила для всех агентов
├── CLAUDE.md                 # Указатель на AGENTS.md для Claude Code
├── .gitignore                # macOS/Windows/Linux, IDE, Python, Node.js, .env, temp/, logs/
├── .cursorignore             # Скрывает локальные секреты от Cursor/AI-агентов
├── .env.example              # Безопасный шаблон переменных окружения
├── .editorconfig             # Единый whitespace/EOL для всех IDE
├── .markdownlint.json        # Конфигурация markdownlint
├── .markdownlint-cli2.jsonc  # Исключения линта для vendored-скиллов
├── skills-lock.json          # Хэши установленных skills (npx skills)
├── .vscode/settings.json     # Видимость .env в IDE
├── .github/workflows/        # CI: markdownlint, docs-guard, ci, deploy
├── router/                   # Роутер LLM-провайдеров (внутренний)
├── agents/                   # Сервис агентов (внутренний)
├── mcp/                      # Служба MCP → challenge.zpq.ai/mcp
├── rag/                      # Индекс проекта на эмбеддингах → challenge.zpq.ai/rag
├── mcpgit/                   # Локальный сервер MCP: ветка и изменённые файлы
├── mcpfiles/                 # Локальный сервер MCP: файлы проекта и очередь задач
├── site/                     # Журнал прогресса на корне домена
├── deploy/                   # caddy/Caddyfile, compose.yml, bootstrap.sh
├── .agents/skills/           # Canonical skills: addyosmani (25) + NVIDIA skill-inspector + /design-review
├── .agents/references/       # Общие чек-листы vendored-набора
├── .claude/agents/           # Роли агентов (11 ролей)
├── .claude/skills/           # Claude Code symlink mirrors to .agents
├── .codex/skills/            # Codex symlink mirrors to .agents
├── .cursor/skills/           # Cursor symlink mirrors to .agents
└── agent_docs/               # Проектная документация
    ├── index.md              # Навигация по документам
    ├── invariants.md         # Жёсткие ограничения продукта
    ├── snapshot.md           # Текущее состояние работы (≤300 строк)
    ├── backlog.md            # Оглавление очереди задач
    ├── backlog/              # Очередь по темам (≤300 строк на файл)
    ├── backlog-closed.md     # Архив закрытых пунктов
    ├── glossary.md           # Глоссарий проекта
    ├── architecture.md       # Архитектура и компоненты
    ├── adr/                  # Атомарный журнал значимых решений
    ├── development-history/  # Атомарный журнал итераций
    ├── setup-checklist.md    # Чек-лист инициализации (удалить после)
    ├── guides/               # Гайды (DoD, окружение, логирование, роли)
    └── templates/            # Шаблоны документов
```

## Состояние

Челлендж пройден, приложения дней сняты в архив 2026-10-20. В проде остались роутер провайдеров, сервис агентов, служба MCP и индекс проекта; стек — Node 22 без runtime-зависимостей, исключения названы картой в `ci.yml` (`agent_docs/adr/2026-09-07-1525-zero-dependency-node.md`). Где сейчас работа — в `agent_docs/snapshot.md`, очередь — в `agent_docs/backlog.md`.

## Быстрый старт для агента

1. Прочитать `AGENTS.md` — раздел «Описание проекта» и принципы.
2. Прочитать `agent_docs/snapshot.md` — где сейчас работа.
3. Прочитать `agent_docs/invariants.md` — что нельзя нарушать.
4. Взять задачу из `agent_docs/backlog/` (оглавление — `agent_docs/backlog.md`), раздел Next.

## Документация

- `AGENTS.md` — принципы работы агента и чек-листы.
- `agent_docs/index.md` — карта всех документов.
- `agent_docs/snapshot.md` — где сейчас работа.

## Заметки

- **Источник истины для решений — git.**
- **Атомарные документы:** одно решение или одна итерация — один файл `YYYY-MM-DD-HHMM-slug.md`. Сквозная нумерация не ведётся.
- **CLAUDE.md — обычный stub-файл, а не symlink** — symlinks ломаются на Windows, в `git archive` и при zip-extract.
- **Языковая политика:** документация на русском, как в шаблоне; код, имена файлов и slug — латиницей.
