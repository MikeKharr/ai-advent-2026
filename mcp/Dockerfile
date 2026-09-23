# Первый образ проекта, который ставит пакеты. Исключение из правила «Node 22
# без runtime-зависимостей» (ADR 2026-09-07-1525) ограничено этой единицей и
# двумя пакетами протокола — ADR 2026-09-23-1227, п. 2. Границу держит не этот
# комментарий, а шаг «Граница runtime-зависимостей» в ci.yml (job detect).
FROM node:22-alpine

# Сервис работает не от root. Своих данных на диске у него нет — тома нет.
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

# Манифест и lock — отдельным слоем до остального кода: слой переиспользуется,
# пока не менялись они сами. `npm ci` требует lock и ставит ровно его версии.
# --ignore-scripts: install-скриптов нет ни у одного пакета дерева (проверено
# при пине, ADR 2026-09-23-1227), и появившийся в обновлении не исполнится.
# --omit=dev и --omit=optional: в образ едет ровно то дерево, которое
# измерено и проверено при пине (ADR 2026-09-23-1227, «Что проверено лично»:
# 94 пакета, 26 МБ, ноль install-скриптов, ноль уязвимостей). Необязательные
# пакеты страж в ci.yml и так запрещает — это второй рубеж на случай, если
# что-то проскочит мимо него (находка reviewer к PR дня 16).
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev --omit=optional && npm cache clean --force

# node_modules из контекста исключён .dockerignore: локальная установка не
# должна подменять собой ту, что поставлена строкой выше.
COPY --chown=app:app . .

USER app
ENV NODE_ENV=production PORT=8083
EXPOSE 8083

# Как у router и agents: проверка изнутри контейнера, без сети наружу.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8083/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
