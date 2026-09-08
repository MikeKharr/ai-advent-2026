FROM node:22-alpine

# Приложение работает не от root.
RUN addgroup -S app && adduser -S app -G app

# Хранилище статей переживает пересоздание контейнера — оно на томе.
RUN mkdir -p /data && chown app:app /data

WORKDIR /app
COPY --chown=app:app . .

USER app
ENV NODE_ENV=production PORT=8080 STORE_FILE=/data/store.json
EXPOSE 8080
VOLUME /data

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
