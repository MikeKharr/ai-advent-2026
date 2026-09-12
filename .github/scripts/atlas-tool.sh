#!/usr/bin/env bash
# Инструмент атласа — клон MikeKharr/project-atlas на закреплённом теге.
# Версия записана здесь и только здесь (ADR 2026-09-12-0440, раздел 1):
# тег читает человек, sha держит версию — тег в чужом репозитории можно
# передвинуть, sha нельзя.
#
#   ATLAS_TOOL=$(bash .github/scripts/atlas-tool.sh)
#   node "$ATLAS_TOOL/build.js" --root . --config atlas/atlas.config.json --out atlas/dist
#   node "$ATLAS_TOOL/build.js" --root . --config atlas/atlas.config.json --check
#
# В stdout — только физический путь к клону (`pwd -P`); сообщения идут в stderr.
# Путь разыменован намеренно. Пройди он через символическую ссылку (на macOS
# /tmp → /private/tmp), `build.js` сравнил бы `process.argv[1]` с уже
# разыменованным `import.meta.url`, не признал бы себя точкой входа и не вызвал
# `main()`: `--check` завершился бы кодом 0, ничего не проверив, — гейт прошёл
# бы молча. В CI не воспроизводится, локально — легко.
# Смена версии — PR класса A по процедуре раздела 4 того же ADR: TOOL_SHA
# берётся командой `git rev-parse v<tag>^{}` в клоне project-atlas, а не
# копируется из описания релиза.
set -euo pipefail

TOOL_REPO=https://github.com/MikeKharr/project-atlas
TOOL_TAG=v2.0.1
TOOL_SHA=27304b80ff7c0aac8ce230373db85558c75f557f

# Пин проверяется до любого обращения к сети: пустая или неполная версия — не
# повод сходить за «каким-нибудь» кодом.
[ -n "$TOOL_TAG" ] || { echo "::error::TOOL_TAG пуст: версия инструмента не задана" >&2; exit 1; }
[ -n "$TOOL_SHA" ] || { echo "::error::TOOL_SHA пуст: версия инструмента не подтверждаема" >&2; exit 1; }
[[ $TOOL_SHA =~ ^[0-9a-f]{40}$ ]] || { echo "::error::TOOL_SHA не полный 40-значный hex: ${TOOL_SHA}" >&2; exit 1; }

# Клон лежит вне рабочего дерева: в Actions — $RUNNER_TEMP, локально — temp/
# (в .gitignore и в запретном списке инструмента). Внутри дерева он сделал бы
# сборку «грязной» (provenance.dirty) и попал бы под шаг секретов docs-guard.
dir=${ATLAS_TOOL_DIR:-${RUNNER_TEMP:-temp}/project-atlas}

# Существующий клон переиспользуется только по той же проверке, что свежий:
# и HEAD равен пину, и рабочее дерево клона чисто. Правленый файл в клоне —
# это другой код, а не сэкономленная минута.
if [ -d "$dir/.git" ]; then
  head=$(git -C "$dir" rev-parse HEAD 2>/dev/null || echo нет)
  dirt=$(git -C "$dir" status --porcelain 2>/dev/null || echo '?? проверка не выполнилась')
  if [ "$head" = "$TOOL_SHA" ] && [ -z "$dirt" ]; then
    printf '%s\n' "$(cd "$dir" && pwd -P)"
    exit 0
  fi
  echo "клон в ${dir} не прошёл проверку (HEAD ${head}) — пересоздаётся" >&2
fi

rm -rf "$dir"
mkdir -p "$(dirname "$dir")"

# Сбой клона — обрыв. Ни отката на ветку по умолчанию, ни `|| true`: три
# попытки закрывают короткий сетевой сбой, после третьей красный шаг честнее
# сборки неизвестно чем.
for attempt in 1 2 3; do
  if git clone --quiet --depth 1 --branch "$TOOL_TAG" "$TOOL_REPO" "$dir" >&2; then
    break
  fi
  rm -rf "$dir"
  if [ "$attempt" -eq 3 ]; then
    echo "::error::клон ${TOOL_REPO} на теге ${TOOL_TAG} не удался за 3 попытки" >&2
    exit 1
  fi
  echo "клон не удался (попытка ${attempt}/3), повтор через $((attempt * 5)) с" >&2
  sleep $((attempt * 5))
done

# До этой строки из клона не исполнено ничего: только git читал его каталог.
head=$(git -C "$dir" rev-parse HEAD)
if [ "$head" != "$TOOL_SHA" ]; then
  echo "::error::тег ${TOOL_TAG} указывает на ${head}, в пине ${TOOL_SHA} — версия инструмента не подтверждена" >&2
  exit 1
fi

printf '%s\n' "$(cd "$dir" && pwd -P)"
