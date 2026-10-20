#!/usr/bin/env bash
# Единицы выкатки — JSON-массив для матрицы build в deploy.yml.
#
#   deploy-units.sh <day> <base> [head]
#
# day  — ввод workflow_dispatch; непустой — выкатывается ровно эта единица.
#        Имя параметра историческое: единиц дней больше нет, единица — это
#        каталог router, agents, mcp или rag (ADR 2026-10-20-0737).
# base — head sha последней успешной выкатки по push. Выкатываются единицы,
#        изменённые в base..head: сюда попадает и код выкаток, которые очередь
#        отменила или которые упали. Пусто (успешных выкаток нет) — все
#        единицы. Не предок head — ошибка: это повтор старого запуска, то есть
#        откат прода, а откат — действие владельца (operations.md).
# Единица — только каталог с Dockerfile в дереве head: удалённая единица не
# попадает в матрицу и не валит сборку.
# Белый список: имя единицы уходит в команду на прод-сервере, поэтому только
# [a-z0-9]+ и только с Dockerfile в дереве head — и для ввода day тоже.
set -eu

day=$1 base=$2 head=${3:-HEAD}
name='^[a-z0-9]+$'

# -z: без него git берёт в кавычки путь с `"`, `\`, табом, `\n` или не-ASCII,
# такой путь не проходит фильтр ниже и пропадает молча, а не валится на белом
# списке. `\n` в имени становится `?`: путь остаётся одной строкой, и имя с ним
# валится на белом списке. pipefail — только внутри подстановки, где нет grep:
# сбой git не пропадает.
tree=$(set -o pipefail; git ls-tree -r -z --name-only "$head" | tr '\n\0' '?\n')
all=$(printf '%s\n' "$tree" | grep -E '^(router|agents|mcp|rag)/Dockerfile$' | sed -E 's#^([^/]+)/Dockerfile$#\1#' | sort -u)

if [ -n "$day" ]; then
  if ! [[ $day =~ $name ]] || ! printf '%s\n' "$all" | grep -qFx -- "$day"; then
    echo "::error::ввод day — не единица выкатки: имя [a-z0-9]+ и Dockerfile в дереве ${head}" >&2
    exit 1
  fi
  printf '%s' "$day" | jq -R . | jq -sc .
  exit 0
fi

if printf '%s\n' "$all" | grep -v '^$' | grep -qvE "$name"; then
  echo "::error::в дереве ${head} есть единица с именем вне [a-z0-9]+" >&2
  exit 1
fi

if [ -z "$base" ]; then
  echo "::warning::успешных выкаток по push нет — выкатываются все единицы" >&2
  printf '%s\n' "$all" | grep -v '^$' | jq -R . | jq -sc .
  exit 0
fi

if ! git merge-base --is-ancestor "$base" "$head" 2>/dev/null; then
  echo "::error::база ${base} не предок ${head}: откат повтором старого запуска запрещён — см. agent_docs/operations.md, раздел «Атлас проекта»" >&2
  exit 1
fi

changed=$(set -o pipefail; git diff -z --name-only "$base" "$head" | tr '\n\0' '?\n')
# Корпус индекса — та же строка, что
# в ci.yml: правка документа или кода живой единицы обязана переехать в индекс
# ВЫКАТКОЙ, а не только пересборкой в CI (ADR 2026-09-29-1639, п. 3). Без неё
# правка документа собирала бы образ rag в CI и не выкатывала его — обещание
# «свежесть держится выкаткой» держалось бы на словах. Совпадение двух копий
# держит rag/test/test_corpus.py::CiRegexTest: он берёт регулярку из ОБОИХ
# файлов и требует, чтобы они были одной строкой.
rag='^(agent_docs/|AGENTS\.md$|README\.md$|rag/|router/|agents/|mcp/|deploy/|\.github/|test/|site/README\.md$)'
printf '%s\n' "$changed" | { grep -oE '^(router|agents|mcp|rag)/' | cut -d/ -f1; printf '%s\n' "$changed" | grep -qE "$rag" && echo rag; } | sort -u | grep -Fx -f <(printf '%s\n' "$all" | grep -v '^$') | jq -R . | jq -sc .
