FROM caddy:2-alpine

# Витрина атласа — статика без серверной работы (ADR 2026-09-13-2000).
# Файлы собирает `node atlas/build.js` в workflow до `docker build`: в образ
# идёт только dist/site, генератор и входы графа — нет. Нет dist/site —
# сборка образа падает на COPY, а не выкатывает пустую страницу.

# Caddy работает не от root; /data и /config — его каталоги состояния.
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /data /config

COPY Caddyfile /etc/caddy/Caddyfile
COPY dist/site /srv

USER app
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
