# [2026-09-07 18:35] Конвейер прожит целиком, ADR по стеку принят

Файл: `agent_docs/development-history/2026-09-07-1835-pipeline-live-adr-accepted.md`

## Что сделано

- Зафиксированы результаты действий владельца, закрывших весь инфраструктурный блок Next, — каждый пункт проверен фактически в этой сессии:
  - репозиторий `MikeKharr/ai-advent-2026` публичен, каркас запушен (main = origin/main);
  - вход по SSH-ключу под пользователем `advent` работает; сервер провиженен `bootstrap.sh` (docker 29.8.0, node на хосте отсутствует — по замыслу);
  - A-запись `challenge.zpq.ai` разрешается в адрес сервера, TLS выдан;
  - секреты `SSH_HOST`, `SSH_USER`, `SSH_KEY` заведены (список имён через GitHub API);
  - пакет GHCR публичен — анонимный pull манифеста отвечает 200;
  - деплой прошёл: на сервере образ `advent-day1` запинен на тег коммита `fdf5feb`, `https://challenge.zpq.ai/` — 200, `https://challenge.zpq.ai/day1/healthz` — 200, `{"ok":true,"day":1,"node":"v22.23.2"}`.
- Владелец принял ADR `2026-09-07-1525-zero-dependency-node.md` (Node 22 без runtime-зависимостей); статус переведён в «Принято».
- Снимок, бэклог и README приведены к этому состоянию.

## Зачем

Снимок перезаписывается каждую итерацию — без атомарной записи первый успешный прогон конвейера и акт принятия ADR не были бы нигде зафиксированы. Разработка ядра дня 1 разблокирована; остаётся спайк `web_search` + строгий JSON.

## Обновлено

- [x] agent_docs/snapshot.md
- [x] agent_docs/backlog.md / backlog-closed.md
- [x] agent_docs/adr/2026-09-07-1525-zero-dependency-node.md (статус «Принято»)
- [x] README.md (раздел «Состояние»)

## Связанные решения

- `agent_docs/adr/2026-09-07-1525-zero-dependency-node.md`
- `agent_docs/adr/2026-09-07-1800-vps-plan-lxs-plus.md`
