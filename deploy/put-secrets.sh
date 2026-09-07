#!/usr/bin/env bash
# Кладёт общий для всех дней deploy/secrets.env на сервер.
#
# Запускается один раз при заведении ключа и потом только при ротации
# (инвариант I-3). Для нового дня запускать НЕ нужно — контейнер дня
# подхватывает этот же файл через env_file в compose.yml.
#
# Ключ вводится скрытно: не сохраняется на локальной машине,
# не попадает в историю shell и не печатается в вывод.
#
# Запуск:  bash deploy/put-secrets.sh
# Переопределения: SSH_KEY=..., SERVER=user@host

set -euo pipefail

SSH_KEY="${SSH_KEY:-$HOME/.ssh/advent_deploy}"
SERVER="${SERVER:-advent@challenge.zpq.ai}"
REMOTE_PATH="ai-advent-2026/deploy/secrets.env"

printf 'Вставьте ANTHROPIC_API_KEY (ввод не отображается) и нажмите Enter:\n> '
read -rs API_KEY
printf '\n'

if [ -z "${API_KEY}" ]; then
  echo "Ключ пустой — ничего не сделано." >&2
  exit 1
fi
case "$API_KEY" in
  sk-ant-*) ;;
  *) echo "Предупреждение: ключ не начинается на sk-ant- . Продолжаю." >&2 ;;
esac

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
chmod 600 "$TMP"

cat > "$TMP" <<EOF
# Общие секреты и лимиты для всех дней. Живёт только на сервере, chmod 600.
# Создан deploy/put-secrets.sh. Специфичное для дня — в deploy/dayN.env.
ANTHROPIC_API_KEY=${API_KEY}
ANTHROPIC_MODEL=claude-sonnet-5

# Контроль расхода (инварианты I-4..I-6)
MAX_SEARCH_USES=4
MAX_OUTPUT_TOKENS=2048
MAX_DAILY_CALLS=50
RATE_LIMIT_PER_MIN=5
RATE_LIMIT_PER_HOUR=30
CACHE_TTL_HOURS=6
EOF

echo "Копирую на ${SERVER}:${REMOTE_PATH} ..."
scp -q -i "$SSH_KEY" "$TMP" "${SERVER}:${REMOTE_PATH}"
ssh -i "$SSH_KEY" "$SERVER" "chmod 600 ${REMOTE_PATH}"

echo "Готово. Проверка (значение ключа не показывается):"
ssh -i "$SSH_KEY" "$SERVER" \
  "ls -l ${REMOTE_PATH}; grep -c '^ANTHROPIC_API_KEY=sk-ant' ${REMOTE_PATH} | sed 's/^/строк с ключом: /'"

echo
echo "Чтобы контейнеры увидели новые значения: docker compose up -d в ${REMOTE_PATH%/*}"
