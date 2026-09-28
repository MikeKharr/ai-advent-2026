# Runtime-зависимостей нет ни одной: JSON-RPC написан руками. `npm ci` здесь
# не вызывается — ставить нечего (ADR 2026-09-23-1227, п. 2).
FROM node:22-alpine

# Сервис работает не от root. Своих данных на диске у него нет — тома нет.
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app
COPY --chown=app:app . .

USER app
ENV NODE_ENV=production PORT=8086
EXPOSE 8086

# Как у router, agents, mcp и mcpnews: проверка изнутри контейнера, без сети наружу.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8086/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
