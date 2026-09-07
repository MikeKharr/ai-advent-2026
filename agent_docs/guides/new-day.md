# Новый день челленджа

Что нужно сделать, чтобы задание дня N появилось на `https://challenge.zpq.ai/dayN/`.
Устройство топологии и конвейера — `agent_docs/architecture.md`, здесь только порядок действий.

## Секреты: делать ничего не нужно

Ключ Anthropic и лимиты лежат на сервере в `deploy/secrets.env` — один файл на все дни.
Сервис дня подключает его через `env_file` в `compose.yml`, поэтому новый день получает
`ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` и лимиты автоматически.

`bash deploy/put-secrets.sh` запускается только при первом заведении ключа и при ротации
(инвариант I-3). Отдельный `deploy/dayN.env` заводится, только если дню нужна своя
настройка; он переопределяет `secrets.env`.

Ключ никогда не появляется в репозитории и в CI (I-1, I-2).

## Имена

Имя каталога задаёт всё остальное и должно совпадать везде: `days/day2/` → сервис `day2`
в `compose.yml` → хост `day2:8080` в `Caddyfile` → образ `advent-day2` → переменная
`DAY2_TAG` (workflow выводит её из имени каталога). Расхождение ломает деплой неочевидно.

## Четыре шага

1. **Каталог `days/dayN/`** — `Dockerfile`, код, `public/`. Проще всего скопировать `days/day1/`.
   Приложение слушает `8080` и отвечает 200 на `/healthz` — CI и Caddy проверяют именно его.
   Ссылки в HTML только относительные (`./healthz`), **без `<base>`**: Caddy делает
   `redir /dayN → /dayN/`, поэтому относительный путь верен и в проде, и при локальном
   запуске на `/`. Жёсткий `<base href="/dayN/">` ломает локальный запуск.

2. **`deploy/Caddyfile`** — две строки рядом с блоком дня 1:

   ```caddyfile
   redir /dayN /dayN/ permanent
   handle_path /dayN/* {
       reverse_proxy dayN:8080 {
           health_uri /healthz
           health_interval 30s
       }
   }
   ```

   `Caddyfile` смонтирован `:ro`, и Caddy сам его не перечитывает. **Проверено на дне 2:
   добавление дня в `depends_on` сервиса `caddy` НЕ заставляет `docker compose up -d`
   пересоздать контейнер** — новый маршрут не доезжает, и проверка живого адреса в
   workflow деплоя падает. После первого деплоя нового дня выполнить на сервере
   `docker compose restart caddy` и перезапустить упавшую проверку
   (`gh run rerun <id> --failed`).

3. **`deploy/compose.yml`** — сервис по образцу `day1`: образ
   `ghcr.io/mikekharr/advent-dayN:${DAYN_TAG:-latest}`, оба `env_file`
   (`./secrets.env` и `./dayN.env`, оба `required: false`), `expose: 8080`,
   и `dayN` в `depends_on` у `caddy`.

4. **Ссылка на лендинге** — `site/index.html`.

## Первый деплой нового дня

Ветка → PR → мерж в `main`. CI собирает образ и проверяет `/healthz`; workflow деплоя
публикует `ghcr.io/mikekharr/advent-dayN:<sha>`, пинит `DAYN_TAG` в `deploy/.env` на сервере,
делает `pull` пересобранных дней и `docker compose up -d` для всех сервисов.

Пакет `advent-dayN` в GHCR, созданный workflow этого публичного репозитория, доступен
анонимно сразу — проверено на дне 2, `docker compose pull` прошёл с первого раза.
Если pull всё же упадёт с ошибкой доступа: сделать пакет публичным в UI GitHub и
перезапустить деплой (`workflow_dispatch` с input `day: dayN`).

**Реальный ручной шаг первого деплоя — Caddy** (см. шаг 2): после выкатки выполнить
`docker compose restart caddy` на сервере и перезапустить упавшую проверку живого адреса.

Проверка: `curl -s https://challenge.zpq.ai/dayN/healthz` → 200.
Откат: предыдущий sha в `DAYN_TAG` и `docker compose up -d dayN`, пересборка не нужна.
