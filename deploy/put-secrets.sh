#!/usr/bin/env bash
# Кладёт общий для всех дней deploy/secrets.env на сервер.
#
# Запускается один раз при заведении ключа и потом только при ротации
# (инвариант I-3). Для нового дня запускать НЕ нужно — контейнер дня
# подхватывает этот же файл через env_file в compose.yml.
#
# Ключ вводится скрытно и уходит на сервер по ssh через stdin: он не
# пишется на диск локальной машины, не попадает в историю shell, в список
# процессов и в вывод. Если файл на сервере уже есть — меняется только
# строка с ключом, остальные значения сохраняются.
#
# Запуск:  bash deploy/put-secrets.sh
# Переопределения: SSH_KEY=..., SERVER=user@host

set -euo pipefail

SSH_KEY="${SSH_KEY:-$HOME/.ssh/advent_deploy}"
SERVER="${SERVER:-advent@challenge.zpq.ai}"
REMOTE_PATH="ai-advent-2026/deploy/secrets.env"

printf 'Вставьте ANTHROPIC_API_KEY (ввод не отображается) и нажмите Enter:\n> '
read -rs API_KEY || true
printf '\n'

if [ -z "${API_KEY:-}" ]; then
  echo "Ключ не введён — ничего не сделано." >&2
  exit 1
fi
case "$API_KEY" in
  sk-ant-*) ;;
  *) echo "Предупреждение: ключ не начинается на sk-ant- . Продолжаю." >&2 ;;
esac

# Скрипт выполняется на сервере, ключ приходит первой строкой stdin.
REMOTE_SCRIPT=$(cat <<REMOTE
set -eu
umask 077
f="${REMOTE_PATH}"
read -r key
if [ -f "\$f" ]; then
  tmp="\$(mktemp "\$(dirname "\$f")/.secrets.XXXXXX")"
  grep -v '^ANTHROPIC_API_KEY=' "\$f" > "\$tmp" || true
  printf 'ANTHROPIC_API_KEY=%s\n' "\$key" >> "\$tmp"
  mv "\$tmp" "\$f"
  echo "Обновлён ANTHROPIC_API_KEY, остальные значения файла сохранены."
else
  { echo '# Общие секреты и лимиты для всех дней. Только на сервере, chmod 600.'
    echo '# Создан deploy/put-secrets.sh. Специфичное для дня — в deploy/dayN.env.'
    printf 'ANTHROPIC_API_KEY=%s\n' "\$key"
    echo 'ANTHROPIC_MODEL=claude-sonnet-5'
    echo ''
    echo '# Контроль расхода (инварианты I-4..I-6)'
    echo 'MAX_SEARCH_USES=4'
    echo 'MAX_OUTPUT_TOKENS=2048'
    echo 'MAX_DAILY_CALLS=50'
    echo 'RATE_LIMIT_PER_MIN=5'
    echo 'RATE_LIMIT_PER_HOUR=30'
    echo 'CACHE_TTL_HOURS=6'
  } > "\$f"
  echo "Файл создан со значениями по умолчанию из .env.example."
fi
chmod 600 "\$f"
ls -l "\$f"
grep -c '^ANTHROPIC_API_KEY=sk-ant' "\$f" | sed 's/^/строк с ключом: /'
REMOTE
)

printf '%s\n' "$API_KEY" | ssh -i "$SSH_KEY" "$SERVER" "$REMOTE_SCRIPT"

cat <<'EOF'

Осталось сделать:
  1. Перезапустить контейнеры, иначе они работают со старым окружением:
       ssh <сервер> 'cd ai-advent-2026/deploy && docker compose up -d'
  2. При ротации — отозвать прежний ключ в консоли Anthropic.
EOF
