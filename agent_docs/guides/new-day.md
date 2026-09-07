# Новый день челленджа

Что нужно сделать, чтобы задание дня N появилось на `https://challenge.zpq.ai/dayN/`.

## Секреты: делать ничего не нужно

Ключ Anthropic и лимиты лежат на сервере в `deploy/secrets.env` — один файл на все дни.
Сервис дня подключает его через `env_file` в `compose.yml`, поэтому новый день получает
`ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` и лимиты автоматически.

`bash deploy/put-secrets.sh` запускается только в двух случаях: первое заведение ключа
и ротация (инвариант I-3). Отдельный `deploy/dayN.env` заводится, только если дню нужна
своя настройка, которой нет в общем файле; он переопределяет `secrets.env`.

Ключ никогда не появляется в репозитории, в CI и на локальной машине (I-1, I-2).

## Четыре шага

1. **Каталог `days/dayN/`** — `Dockerfile`, код, `public/`. Проще всего скопировать `days/day1/`.
   Приложение слушает `8080` и отвечает 200 на `/healthz` — CI и Caddy проверяют именно его.
   В HTML обязателен `<base href="/dayN/">`: Caddy срезает префикс, приложение видит `/`.

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

3. **`deploy/compose.yml`** — сервис по образцу `day1`: образ
   `ghcr.io/mikekharr/advent-dayN:${DAYN_TAG:-latest}`, оба `env_file`
   (`./secrets.env` и `./dayN.env`, оба `required: false`), `expose: 8080`,
   и `dayN` в `depends_on` у `caddy`.

4. **Ссылка на лендинге** — `site/index.html`.

## Деплой

Ветка → PR → мерж в `main`. Дальше автоматически: CI собирает образ и проверяет `/healthz`,
workflow деплоя публикует `ghcr.io/mikekharr/advent-dayN:<sha>`, пинит `DAYN_TAG` в
`deploy/.env` на сервере и поднимает только изменённые дни.

Первый деплой нового дня требует `git pull` на сервере — сервисы читаются из `compose.yml`
из рабочей копии. Это делает workflow.

Проверка: `curl -s https://challenge.zpq.ai/dayN/healthz` → 200.
Откат: предыдущий sha в `DAYN_TAG` и `docker compose up -d dayN`, пересборка не нужна.

## Границы

Дни изолированы по стеку, отказу и деплою: день на другом языке не затрагивает соседей.
Общее у них только Caddy, файл секретов и лендинг.
