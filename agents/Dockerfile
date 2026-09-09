FROM node:22-alpine

# Сервис работает не от root; архив статей — на томе /data.
RUN addgroup -S app && adduser -S app -G app && mkdir -p /data && chown app:app /data

WORKDIR /app
COPY --chown=app:app . .

USER app
ENV NODE_ENV=production PORT=8082 STORE_FILE=/data/store.json
EXPOSE 8082
VOLUME /data

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8082/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
