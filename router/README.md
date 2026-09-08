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
src/adapters/  anthropic (Messages API), ollama (родной /api/generate)
src/ledger.js  журнал расхода JSONL, суточные суммы
src/service.js HTTP: /v1/route, /v1/spend, /v1/metrics, /healthz
server.js      точка входа
```
