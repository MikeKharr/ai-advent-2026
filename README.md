# ai-advent-2026

Веб-приложение AI Advent 2026: вводишь сферу — получаешь 3 главные свежие новости стартапов в ней, со ссылками на источники.

Отвечает Claude через Anthropic Messages API с server-side инструментом `web_search`, поэтому новости настоящие и свежие, а не восстановленные из обучающих данных.

Репозиторий построен на `2030ai/2030ai-project-template` с memory-слоем из `cmit-ru/cmit-starter`.

**Продакшен:** `https://challenge.zpq.ai` — лендинг со списком дней, `challenge.zpq.ai/dayN` — задание дня N.

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
├── days/                     # Одно задание — один каталог — один контейнер
│   └── day1/                 # → challenge.zpq.ai/day1
├── site/                     # Лендинг на корне домена
├── deploy/                   # Caddyfile, compose.yml, bootstrap.sh
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
    ├── backlog.md            # Очередь задач (≤300 строк)
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

Каркас, конвейер деплоя и сервер работают: заглушка дня 1 доступна по HTTPS. Стек принят — Node 22 без runtime-зависимостей (`agent_docs/adr/2026-09-07-1525-zero-dependency-node.md`). **Прикладного кода ещё нет** — следующий шаг спайк `web_search` + строгий JSON. Что делать дальше — в `agent_docs/snapshot.md` и `agent_docs/backlog.md`.

## Быстрый старт для агента

1. Прочитать `AGENTS.md` — раздел «Описание проекта» и принципы.
2. Прочитать `agent_docs/snapshot.md` — где сейчас работа.
3. Прочитать `agent_docs/invariants.md` — что нельзя нарушать.
4. Взять задачу из `agent_docs/backlog.md`, раздел Next.

## Документация

- `AGENTS.md` — принципы работы агента и чек-листы.
- `agent_docs/index.md` — карта всех документов.
- `agent_docs/snapshot.md` — где сейчас работа.

## Заметки

- **Источник истины для решений — git.**
- **Атомарные документы:** одно решение или одна итерация — один файл `YYYY-MM-DD-HHMM-slug.md`. Сквозная нумерация не ведётся.
- **CLAUDE.md — обычный stub-файл, а не symlink** — symlinks ломаются на Windows, в `git archive` и при zip-extract.
- **Языковая политика:** документация на русском, как в шаблоне; код, имена файлов и slug — латиницей.
