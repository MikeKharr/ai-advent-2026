# Атлас проекта

Единица выкатки `atlas` — публичная страница `challenge.zpq.ai/atlas/`. Код
генератора живёт не здесь: он в
[`MikeKharr/project-atlas`](https://github.com/MikeKharr/project-atlas), и
приходит клоном на закреплённом теге (ADR
`agent_docs/adr/2026-09-12-0440-atlas-migration-to-project-atlas.md`). Версия
записана в одном месте — `.github/scripts/atlas-tool.sh` (`TOOL_TAG`,
`TOOL_SHA`); её смена — PR класса A по процедуре раздела 4 того же ADR.

Что лежит здесь:

```text
atlas.config.json  что читать в этом репозитории: документы, роли, скиллы, деплой (формат 2)
overlay.json       единственный ручной файл: классы гейтов, фазы, внешние сервисы, исключения
Dockerfile         образ caddy:2-alpine поверх собранного dist/site
Caddyfile          раздача dist/site и 200 на /healthz
dist/              выход сборки; в .gitignore, в репозиторий не попадает
```

## Сборка локально

```sh
ATLAS_TOOL=$(bash .github/scripts/atlas-tool.sh)                                          # клон инструмента в temp/
node "$ATLAS_TOOL/build.js" --root . --config atlas/atlas.config.json --out atlas/dist     # graph.json, site/, vault/
node "$ATLAS_TOOL/build.js" --root . --config atlas/atlas.config.json --check              # гейт ссылок, ничего не пишет
node "$ATLAS_TOOL/build.js" --root . --config atlas/atlas.config.json --out atlas/dist --serve
```

Первый запуск требует сети (клон), дальше клон переиспользуется, пока его
`HEAD` равен пину и его дерево чисто. Клон лежит вне рабочего дерева
(`temp/` локально, `$RUNNER_TEMP` в Actions): внутри он сделал бы сборку
«грязной» в подвале страницы.

Каталог `atlas/dist`, оставшийся от прежнего пакета, надо один раз удалить:
инструмент отказывается писать в непустой каталог без своей метки
`.project-atlas` и выходит с кодом 2.

`--check` — шаг обязательной проверки `guard`
(`.github/workflows/docs-guard.yml`): падает закрыто на цитате ADR без файла,
ссылке на несуществующий документ, инварианте, которого нет, роли или сервисе
из `overlay.json` без источника, непонятой строке `compose.yml`. Сообщение
называет файл и строку — чинится в источнике, не в атласе.

Что инструмент читает, что считает и как выглядит витрина — документация
project-atlas (`docs/input-spec.md`, `README.md`). Откат единицы в проде по
`ATLAS_TAG` — `agent_docs/operations.md`, раздел «Атлас проекта».
