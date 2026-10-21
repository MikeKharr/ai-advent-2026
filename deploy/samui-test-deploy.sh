#!/bin/bash
# Выкатка стенда `test` проекта samui-villas — forced command ключа выкатки
# (ADR agent_docs/adr/2026-10-20-1621-samui-test-forced-command.md; в
# samui-villas — ADR 2026-10-20-1259-stand-robots-entry-points.md, П4-а).
#
# Ключ стоит в ~/.ssh/authorized_keys пользователя `advent` строкой
#   restrict,command="/home/advent/ai-advent-2026/deploy/samui-test-deploy.sh" ssh-ed25519 …
# и ничего, кроме этого скрипта, исполнить не может: sshd подставляет его
# вместо любой присланной команды, а присланная лежит в SSH_ORIGINAL_COMMAND.
#
# Закрытый список действий — ровно один проход, без выбора:
#   вход в GHCR → pull образа по digest → logout → файлы стенда из образа →
#   postgres → миграции → пересев → app и caddy → дымовая проверка → ps.
# Привязка — к проекту compose `samui-test` в ~/samui-villas/deploy/test:
# проект, каталог и файл compose заданы здесь, а не присланы.
#
# Что приходит снаружи — и только это:
#   SSH_ORIGINAL_COMMAND — ровно `sha256:<64 hex>` (digest образа этого
#     прогона); любая другая строка, в том числе с пробелом или вторым
#     словом, — отказ до первого вызова docker;
#   stdin, первая строка — эфемерный GITHUB_TOKEN прогона (packages: read).
#     Логин — во временный каталог конфигурации docker, logout и удаление —
#     сразу после pull: ~/.docker/config.json пользователя `advent` не
#     трогается, на диске токен не переживает этот проход.
#
# Чистое окружение: каждый вызов docker идёт через `clean` (`env -i` с
# фиксированными PATH и HOME). Compose берёт переменную из окружения процесса
# раньше, чем из `.env` проекта: без `env -i` любое имя из окружения `advent`
# (например, ключ модели адвента) подменило бы значение стенда из его `.env`.
# Держит test/samui-test-deploy.test.js.
#
# Чего скрипт НЕ держит: содержимое compose.yml и Caddyfile приходит из образа
# с этим digest (`/app/deploy/test/`), то есть доверие стоит на том, что образ
# в ghcr.io/mikekharr/samui-villas собран из main samui-villas, где compose
# судит страж `deploy-guard.mjs`. Проект (`-p samui-test`) и каталог скрипт
# задаёт сам, поэтому чужой compose не переименует проект, но тома и сети он
# называет сам — граница названа в ADR.
set -euo pipefail
umask 077

readonly CLEAN_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
PATH=$CLEAN_PATH
export PATH

readonly REPO=ghcr.io/mikekharr/samui-villas
readonly PROJECT=samui-test
readonly DIR="$HOME/samui-villas/deploy/test"
readonly FILES=(compose.yml Caddyfile smoke.mjs)

refuse() {
  echo "отказ: $1" >&2
  exit 64
}

digest=${SSH_ORIGINAL_COMMAND-}
[[ $digest =~ ^sha256:[0-9a-f]{64}$ ]] || refuse 'ожидается ровно sha256:<64 hex> — digest образа'
readonly IMAGE="$REPO@$digest"

token=
IFS= read -r token || true
[[ $token =~ ^[A-Za-z0-9_]+$ ]] || refuse 'нет токена GHCR первой строкой stdin'

[ -f "$DIR/.env" ] || refuse "нет $DIR/.env — его кладёт владелец"

# Каждый вызов docker — только через эту функцию (держит тест).
clean() {
  env -i PATH="$CLEAN_PATH" HOME="$HOME" "$@"
}

compose() {
  clean APP_IMAGE="$IMAGE" docker compose -p "$PROJECT" --project-directory "$DIR" -f "$DIR/compose.yml" "$@"
}

cfg=
cid=
staging=
cleanup() {
  if [ -n "$cfg" ]; then
    clean docker --config "$cfg" logout ghcr.io > /dev/null 2>&1 || true
    rm -rf "$cfg"
  fi
  if [ -n "$cid" ]; then
    clean docker rm -f "$cid" > /dev/null 2>&1 || true
  fi
  if [ -n "$staging" ]; then
    rm -rf "$staging"
  fi
}
trap cleanup EXIT

# Две выкатки подряд не идут одновременно: вторая ждёт первую.
exec 9> "$DIR/.deploy.lock"
flock -w 600 9 || refuse 'другая выкатка стенда держит замок дольше 10 минут'

echo "==> образ $IMAGE"
cfg=$(mktemp -d)
printf '%s' "$token" | clean docker --config "$cfg" login ghcr.io -u samui-stand --password-stdin > /dev/null
token=
clean docker --config "$cfg" pull -q "$IMAGE" < /dev/null
clean docker --config "$cfg" logout ghcr.io > /dev/null
rm -rf "$cfg"
cfg=

echo "==> файлы стенда из образа: ${FILES[*]}"
staging=$(mktemp -d "$DIR/.incoming.XXXXXX")
cid=$(clean docker create "$IMAGE")
for f in "${FILES[@]}"; do
  clean docker cp "$cid:/app/deploy/test/$f" "$staging/$f"
  # Только обычный файл: ссылка в образе указала бы compose на файл хоста.
  [ -f "$staging/$f" ] && [ ! -L "$staging/$f" ] || refuse "$f в образе — не обычный файл"
done
clean docker rm "$cid" > /dev/null
cid=
for f in "${FILES[@]}"; do
  chmod 644 "$staging/$f"
  mv -f "$staging/$f" "$DIR/$f"
done
rmdir "$staging"
staging=

fail() {
  echo "::error::$1"
  compose logs --no-color --tail 60 < /dev/null || true
  exit 1
}

echo '==> postgres'
compose up -d --wait postgres < /dev/null || fail 'postgres не поднялся'
echo '==> миграции'
compose run --rm -T ops node dist/migrate.js < /dev/null || fail 'миграции не прошли'
echo '==> пересев'
compose run --rm -T ops node dist/tools/seed-stand.js < /dev/null || fail 'пересев не прошёл'
# caddy пересоздаётся всегда: Caddyfile монтирован файлом, а новый файл —
# новый inode, который живой контейнер не видит.
echo '==> app и caddy'
compose up -d --wait --force-recreate app caddy < /dev/null || fail 'app или caddy не поднялись'
echo '==> дымовая проверка'
compose exec -T app node --input-type=module - < "$DIR/smoke.mjs" || fail 'дымовая проверка красная'
compose ps --format '{{.Service}} {{.Status}}' < /dev/null
