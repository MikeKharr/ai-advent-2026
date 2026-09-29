# python:3.12-slim по digest, а не по тегу: тег переезжает молча.
FROM python:3.12-slim@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f

# Реестр закреплён здесь, а не оставлен окружению.
#   PIP_CONFIG_FILE=/dev/null — pip не читает ни /etc/pip.conf, ни
#     ~/.config/pip/pip.conf: файл в образе базы или на раннере увёл бы
#     установку на чужой индекс мимо requirements.txt, который читает страж.
#   --index-url в самой команде — явный флаг сильнее переменной окружения
#     PIP_INDEX_URL, поэтому переменная в сборочной среде тоже ничего не
#     решает. Хэши прибивают байты, но это второй замок: список закрыт
#     только пока закрыт источник (условие гейта к заходу 2).
# Держит эти две строки шаг «Реестр пакетов не переопределяется» в
# .github/workflows/ci.yml.
ENV PIP_CONFIG_FILE=/dev/null \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# --only-binary=:all: — аналог `npm ci --ignore-scripts`: колесо не
# исполняет setup.py. --require-hashes + --no-deps — байты и список.
COPY requirements.txt ./
RUN pip install --no-cache-dir \
      --index-url https://pypi.org/simple \
      --only-binary=:all: --require-hashes --no-deps \
      -r requirements.txt

# Служба работает не от root. Индекс живёт в томе /data (заход 3), корпус
# приезжает в образе шагом CI до docker build.
RUN useradd --system --create-home --uid 10021 app \
 && mkdir -p /data && chown app:app /data
COPY --chown=app:app . /app

USER app
ENV PORT=8086 RAG_CORPUS=/app/corpus RAG_INDEX=/data
EXPOSE 8086

# Как у router, agents и mcp: проверка изнутри контейнера, без сети наружу.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8086/healthz', timeout=2).status==200 else 1)"

CMD ["python", "serve.py"]
