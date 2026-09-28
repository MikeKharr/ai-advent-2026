# Роутер LLM-провайдеров

Отдельный сервис: выбирает провайдера по классу задачи, следит за здоровьем
провайдеров, хранит ключи к моделям, ведёт учёт расхода и лимиты по приложениям.
Архитектура — `agent_docs/adr/2026-09-08-1748-llm-router.md`, эксплуатация —
`agent_docs/operations.md`.

Node 22, без зависимостей.

```sh
node --test test/*.test.js
ANTHROPIC_API_KEY=… ROUTER_ADMIN_KEY=… APP_KEY_SMOKE=… node server.js
```

```text
config/        providers.json, classes.json, apps.json — данные, не код
src/config.js  валидация; битая конфигурация — крах на старте
src/registry.js реестр провайдеров за швом (list())
src/health.js  отрицательный кэш, предохранитель, 429, ёмкость хоста
src/router.js  createRouter().route(): возможность → политика → здоровье
src/adapters/  anthropic (Messages API), groq и kimi (OpenAI-совместимые),
               ollama (родной /api/generate)
src/ledger.js  журнал расхода JSONL, суточные суммы
src/service.js HTTP: /v1/route, /v1/spend, /v1/metrics, /healthz
server.js      точка входа
admin.js       чтение /v1/spend и /v1/metrics изнутри контейнера: ровно два
               аргумента, ключ из окружения, вывод без него (ADR 2026-09-16-0907)
```

## Вход `POST /v1/route`

Ровно один из двух: строка `input` (дни 6–16) либо диалог `messages[]` с
блоками `text`, `tool_use`, `tool_result` и определения инструментов
`tools[]` (`name`/`description`/`input_schema`) для цикла `tool_use`
(ADR `2026-09-28-0736`, п. 2). `tools[]` принимает только класс, который
объявил возможность `tools` в `config/classes.json` (сейчас — `tool_use`):
на любом другом классе запрос с определениями отвергается до вызова, иначе
потолок ответа и бюджет брались бы у класса пощедрее. Объём `tools[]`
входит в меру запроса при обеих формах входа. Ответ несёт `content[]` и
`stopReason` провайдера как есть — блок `tool_use` вызывающий видит
блоком, а не строкой `text`.
