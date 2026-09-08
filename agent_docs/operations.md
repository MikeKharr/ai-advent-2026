# Эксплуатация

Как запускать и обслуживать то, что работает в проде. Конвейер деплоя дней —
`architecture.md` и `guides/new-day.md`; здесь — сервис роутера LLM-провайдеров
(ADR `2026-09-08-1748-llm-router.md`).

## Роутер: что это и где живёт

Отдельный контейнер `router` в `deploy/compose.yml`, без публичного адреса и записи
в `Caddyfile`. Приложения дней обращаются к нему по сети compose:
`http://router:8081`. Код — `router/`, конфигурация — `router/config/*.json`,
секреты — `deploy/router.env` на сервере (в репозитории только имена переменных).

| Файл | Что задаёт |
|---|---|
| `router/config/providers.json` | Провайдеры прода: id, kind, ярус, адрес, модель, профиль, возможности, `secretEnv` |
| `router/config/classes.json` | Реестр классов задач: ярусы, требования, уровень размышлений, `answerTokens` |
| `router/config/apps.json` | Приложения: `secretEnv` ключа, разрешённые классы, суточные лимиты |
| `deploy/router.env` | `ANTHROPIC_API_KEY`, `ROUTER_ADMIN_KEY`, `APP_KEY_*` — имена берутся из `secretEnv` |

Битая конфигурация или отсутствующая переменная — крах на старте с текстом причины
в логе (`docker compose logs router`). Это задумано: роутер не стартует наполовину.

## Эндпоинты

| Метод и путь | Кто | Что |
|---|---|---|
| `POST /v1/route` | приложение, `Authorization: Bearer <ключ приложения>` | тело `{ taskClass, input, system?, schema?, requires?, dataClass?, thinking?, budgetMs?, temperature?, promptVersion? }`; ответ — контракт ADR плюс `app` и `budgetLeft` |
| `GET /v1/spend` | админ | расход и остатки по приложениям за сутки и месяц UTC, по классам и провайдерам |
| `GET /v1/metrics` | админ | счётчики по провайдерам и состояние здоровья (кэш, предохранитель, inflight) |
| `GET /healthz` | любой | 200, если процесс жив |

Коды отказа `/v1/route`: 401 неизвестный ключ; 403 класс не разрешён приложению;
400 тело не по схеме; 429 `budget_exceeded` с `resetAt`; 422 `refused` / `no_provider`;
503 `all_failed` с `reasons[]` по каждому провайдеру.

## Первый запуск на сервере

1. Создать `deploy/router.env` (права 600), заполнив переменные из таблицы выше.
   Ключи приложений и админа — длинные случайные строки, например
   `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`.
2. Смерж в `main` изменений в `router/` собирает образ и выкатывает сервис;
   workflow ждёт `healthy` по healthcheck контейнера (публичного адреса нет).
3. Проверка изнутри сервера:
   `docker compose exec router node -e "fetch('http://127.0.0.1:8081/healthz').then(r=>r.text()).then(console.log)"`.
4. Расход: `docker compose exec router node -e "fetch('http://127.0.0.1:8081/v1/spend',{headers:{authorization:'Bearer '+process.env.ROUTER_ADMIN_KEY}}).then(r=>r.text()).then(console.log)"`.

Журнал расхода — `/data/ledger.jsonl` на томе `router_data`: по строке на вызов
провайдера (приложение, класс, провайдер, уровень, токены, поиски, цена, исход),
без промптов. Неудачный вызов без `usage` записывается по оценке входа с пометкой
`estimated`. Лимит сверяется с остатком до вызова по оценке запроса (вход плюс
потолок выхода на два вызова): большой запрос получает `budget_exceeded`, даже
если остаток ещё не ноль. Суммы восстанавливаются при перезапуске; число
неразобранных строк — в стартовой записи лога.

## Добавить приложение

Запись в `router/config/apps.json` с `id`, `secretEnv`, списком классов и хотя бы
одним лимитом (`dailyTokens` или `dailyCostUsd`); переменную с ключом — в
`deploy/router.env`. Лимиты меняются коммитом; админ-интерфейс — позже.
Приложение без лимита роутер не запустит.

## Добавить или подключить провайдера

Провайдер существующего `kind` (`anthropic`, `ollama`) — только запись в
`providers.json`; код не трогается, это проверяется тестом
(`router/test/router.test.js`, «добавление провайдера — только правка конфигурации»).
Новый `kind` — адаптер в `router/src/adapters/` с тем же контрактом `call()`.

### Self-hosted провайдер (Ollama)

1. На машине с моделью: `ollama pull <модель>`, убедиться, что API отвечает:
   `curl http://127.0.0.1:11434/api/tags`.
2. Роутер ходит в **родной** API (`POST /api/generate`, `stream:false`), а не в слой
   совместимости с OpenAI: только он отдаёт `load_duration`, `eval_count` и принимает
   `think`. Значение `think` по уровням задаётся в поле `thinking` записи провайдера:
   у qwen3 это булево (`"low": true`), у gpt-oss — строка (`"low": "low"`).
3. Запись провайдера: `kind: "ollama"`, `tier: "self-hosted"`, `profile: "laptop"`
   (или `server`), `maxConcurrency: 1` для ноутбука, `capabilities: ["json_schema"]`,
   `dataClasses` шире облачных — данные не покидают периметр. Образец —
   `router/config/providers.local.example.json`.
4. Профиль задаёт дедлайн по формуле ADR (загрузка 20 с, генерация не ниже 6.4 ток/с
   для `laptop`); переопределить можно полем `timeouts: { loadMs, promptEvalTps, genTpsFloor }`.
5. Локальный запуск роутера с ноутбучным провайдером:

   ```sh
   cp router/config/providers.local.example.json router/config/providers.local.json
   ROUTER_PROVIDERS=providers.local.json ANTHROPIC_API_KEY=… ROUTER_ADMIN_KEY=… \
     APP_KEY_SMOKE=… node router/server.js
   ```

   `providers.local.json` в `.gitignore` не нужен — адресов и ключей в нём нет, но в
   прод он не попадает: сервер читает `providers.json`.
6. **Ограничение сейчас:** с сервера ноутбук не виден. Пока нет tailnet, ноутбучный
   провайдер работает только при запуске роутера на той же машине; продовая
   конфигурация — только облако. Когда появится сеть, достаточно вписать адрес
   ноутбука в `baseUrl` продового `providers.json`.

## Что смотреть при инциденте

- `docker compose logs --tail 200 router` — каждое обращение к провайдеру, пропуск
  и отказ пишутся строкой JSON с `provider`, `thinking`, `outcome`, `reason`.
- `/v1/metrics` — если у провайдера растёт `skipped`, причина в `health`:
  отрицательный кэш (транспорт), предохранитель (три неудачи подряд, 60 с),
  `busyUntil` (429) или исчерпанная ёмкость хоста.
- Откат образа — как у дней: `ROUTER_TAG=<прежний sha>` в `deploy/.env` и
  `docker compose up -d router`.
