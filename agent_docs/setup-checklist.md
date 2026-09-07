# Чек-лист инициализации нового проекта

Одноразовый чек-лист. После прохождения — удалить файл.

## 1. Описание проекта

- [x] Заполнен раздел «Описание проекта» в `AGENTS.md`.

## 2. Окружение

- [x] `.vscode/settings.json` — видимость `.env` в IDE
- [x] `.cursorignore` — правила скрытия секретов от AI-агентов
- [x] `.gitignore` — правила `.env`/`.env.*`
- [x] `.env.example` — шаблон переменных

## 3. Глоссарий

- [x] `agent_docs/glossary.md` заполнен начальной терминологией.

## 4. Архитектура

- [x] `agent_docs/architecture.md` заполнен.

## 5. Memory-слой

- [x] `agent_docs/invariants.md`, `snapshot.md`, `backlog.md`, `backlog-closed.md` созданы.
- [x] CI проверяет лимит 300 строк.

## 6. Роли агентов

- [x] `.claude/agents/*.md` — 10 ролей.
- [x] `agent_docs/guides/agent-roles.md` — карта ролей и протокол передачи.

## 7. Project-local skills

- [ ] При появлении потребности: canonical source `.agents/skills/<name>/SKILL.md` + symlink-зеркала.

## 8. Осталось владельцу

- [ ] Создать публичный репозиторий и запушить каркас.
- [ ] Настроить branch protection на `main`.
- [ ] Добавить секреты репозитория.
- [ ] Удалить этот файл.
