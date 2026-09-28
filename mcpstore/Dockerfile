# Node 24 ради ВСТРОЕННОГО `node:sqlite` без флага (ADR 2026-09-28-0736, п. 3):
# так состояние держится без единого пакета — правило «Node без
# runtime-зависимостей» (ADR 2026-09-07-1525) для этой единицы действует целиком.
FROM node:24-alpine

# Сервис работает не от root. Том /data принадлежит ему же.
RUN addgroup -S app && adduser -S app -G app && mkdir -p /data && chown app:app /data

WORKDIR /app
COPY --chown=app:app . .

USER app
ENV NODE_ENV=production PORT=8085 STORE_DB_PATH=/data/store.db
EXPOSE 8085
VOLUME ["/data"]

# Как у router, agents и mcp: проверка изнутри контейнера, без сети наружу.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8085/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
