#!/usr/bin/env bash
# Правка Caddyfile доезжает до живого входа — шаг CI «Правка Caddyfile
# доезжает до живого входа» (ci.yml, job caddyfile).
#
# Что держит. Что монтировка КАТАЛОГА показывает уже работающему контейнеру
# Caddy новое содержимое файла после подмены файла новым inode, а монтировка
# одиночного файла — НЕ показывает. Подмена делается ровно так, как её делает
# обновление репозитория на сервере: новый файл рядом и переименование на то
# же имя, то есть смена записи в каталоге, а не правка на месте.
#
# Чего не держит. Что в deploy/compose.yml монтируется именно каталог: здесь
# поднимаются свои контейнеры с собственными монтировками, и возврат старой
# строки в compose.yml этот шаг зелёным оставит. Текст compose.yml держит
# test/caddy-mount.test.js. Здесь — механика, там — наша строка.
#
# Почему живым прогоном. Поведение монтировок — свойство докера и образа, а не
# нашего файла: его может сменить обновление caddy или раннера, не тронув ни
# одной нашей строки, и тогда текстовый страж останется зелёным при вернувшемся
# дефекте.
#
# Сверяется ТЕЛО ответа, а не код: у Caddy запрос, не совпавший ни с одним
# маршрутом, получает пустой 200, и проверка «новый маршрут даёт не 404» ничего
# бы не различала. Тело «before»/«after» прямо показывает, какое содержимое
# держит живой процесс.
#
# Запуск из корня репозитория: bash .github/scripts/caddy-mount-check.sh
set -euo pipefail

IMAGE=caddy:2-alpine
WORK="${RUNNER_TEMP:-/tmp}/caddy-mount-check.$$"
DIR_NAME=cmc-dir
FILE_NAME=cmc-file
DIR_PORT=8097
FILE_PORT=8098

cleanup() {
  docker rm -f "$DIR_NAME" "$FILE_NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

config() {
  printf ':80 {\n\trespond /probe "%s" 200\n}\n' "$1"
}

# Подмена ровно как у обновления репозитория: новый файл рядом и
# переименование на то же имя. Никакой правки на месте — inode меняется.
replace_as_repo_update() {
  config after > "${1}.new"
  mv "${1}.new" "$1"
}

probe() {
  curl -fsS "http://127.0.0.1:${1}/probe"
}

wait_ready() {
  local port=$1 name=$2
  for _ in $(seq 1 30); do
    if [ "$(probe "$port" || true)" = "before" ]; then return 0; fi
    sleep 1
  done
  echo "::error::контейнер ${name} не отдал «before» на /probe за 30 с — стенд не поднялся, о монтировках прогон ничего не говорит"
  docker logs "$name" 2>&1 | tail -20
  return 1
}

mkdir -p "$WORK/dir" "$WORK/file"
config before > "$WORK/dir/Caddyfile"
config before > "$WORK/file/Caddyfile"

docker run -d --name "$DIR_NAME" -p "127.0.0.1:${DIR_PORT}:80" \
  -v "$WORK/dir:/etc/caddy:ro" "$IMAGE" >/dev/null
docker run -d --name "$FILE_NAME" -p "127.0.0.1:${FILE_PORT}:80" \
  -v "$WORK/file/Caddyfile:/etc/caddy/Caddyfile:ro" "$IMAGE" >/dev/null

# Оба стенда обязаны ответить «before» до подмены: иначе «after» ниже
# доказывал бы не то, что правка доехала, а что стенд наконец поднялся.
wait_ready "$DIR_PORT" "$DIR_NAME"
wait_ready "$FILE_PORT" "$FILE_NAME"

replace_as_repo_update "$WORK/dir/Caddyfile"
replace_as_repo_update "$WORK/file/Caddyfile"

# Та же команда, что делает выкатка. Отказ reload — тоже отказ шага: в проде
# он красит выкатку, и здесь молчать о нём нельзя.
docker exec "$DIR_NAME" caddy reload --adapter caddyfile --config /etc/caddy/Caddyfile
docker exec "$FILE_NAME" caddy reload --adapter caddyfile --config /etc/caddy/Caddyfile

fail=0

dir_body=$(probe "$DIR_PORT")
if [ "$dir_body" = "after" ]; then
  echo "ok: монтировка каталога — после подмены файла и reload живой вход отдаёт новое содержимое"
else
  echo "::error::монтировка каталога: /probe отдал «${dir_body}», а не «after» — правка Caddyfile до живого входа НЕ доезжает, и выкатка снова будет зелёной при неприменённой конфигурации"
  fail=1
fi

file_body=$(probe "$FILE_PORT")
if [ "$file_body" = "before" ]; then
  echo "ok: приманка — монтировка одиночным файлом держит прежнее содержимое при успешном reload (дефект воспроизведён)"
else
  echo "::error::приманка не воспроизвела дефект: монтировка одиночным файлом отдала «${file_body}», а не «before». Прогон перестал различать две монтировки и больше ничего не доказывает"
  fail=1
fi

exit "$fail"
