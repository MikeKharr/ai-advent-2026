#!/usr/bin/env bash
# Единицы выкатки — JSON-массив для матрицы build в deploy.yml.
#
#   deploy-units.sh <day> <base> [head]
#
# day  — ввод workflow_dispatch; непустой — выкатывается ровно эта единица.
# base — head sha последней успешной выкатки по push. Выкатываются единицы,
#        изменённые в base..head: сюда попадает и код выкаток, которые очередь
#        отменила или которые упали. Пусто (успешных выкаток нет) — все
#        единицы. Не предок head — ошибка: это повтор старого запуска, то есть
#        откат прода, а откат — действие владельца (operations.md).
# Единица — только каталог с Dockerfile в дереве head: удалённый день не
# попадает в матрицу и не валит сборку.
set -eu

day=$1 base=$2 head=${3:-HEAD}

if [ -n "$day" ]; then
  printf '%s' "$day" | jq -R . | jq -sc .
  exit 0
fi

all=$(git ls-tree -r --name-only "$head" | grep -E '^(days/[^/]+|router|agents|atlas)/Dockerfile$' | sed -E 's#^(days/)?([^/]+)/Dockerfile$#\2#' | sort -u)

if [ -z "$base" ]; then
  echo "::warning::успешных выкаток по push нет — выкатываются все единицы" >&2
  printf '%s\n' "$all" | grep -v '^$' | jq -R . | jq -sc .
  exit 0
fi

if ! git merge-base --is-ancestor "$base" "$head" 2>/dev/null; then
  echo "::error::база ${base} не предок ${head}: откат повтором старого запуска запрещён — см. agent_docs/operations.md, раздел «Атлас проекта»" >&2
  exit 1
fi

changed=$(git diff --name-only "$base" "$head")
# Входы графа атласа — atlas/lib/sources.js; то же правило, что в ci.yml.
atlas='^(atlas/|agent_docs/|\.claude/agents/|\.agents/skills/[^/]+/SKILL\.md$|AGENTS\.md$|skills-lock\.json$|deploy/(compose\.yml|Caddyfile)$|site/index\.html$|router/config/providers\.json$)'
printf '%s\n' "$changed" | { grep -oE '^days/[^/]+' | cut -d/ -f2; printf '%s\n' "$changed" | grep -oE '^(router|agents)/' | cut -d/ -f1; printf '%s\n' "$changed" | grep -qE "$atlas" && echo atlas; } | sort -u | grep -Fx -f <(printf '%s\n' "$all" | grep -v '^$') | jq -R . | jq -sc .
