# [2026-09-07 23:55] Установлен набор скиллов addyosmani/agent-skills

Файл: `agent_docs/development-history/2026-09-07-2355-agent-skills-installed.md`

## Что сделано

- По поручению владельца установлены все 25 скиллов `addyosmani/agent-skills`
  (коммит источника `48cb116`) в `.agents/skills/` с симлинками-зеркалами в
  `.claude/skills`, `.codex/skills`, `.cursor/skills` — по проектной конвенции;
  содержимое зафиксировано хэшами в `skills-lock.json`, пин коммита — в ADR.
- Скопированы общие чек-листы источника в `.agents/references/` (установщик их не
  переносит — скиллы ссылаются на `../../references/*.md`) и локальные допфайлы
  скиллов `constraint-driven-development` (`references/floor-guard.md`) и
  `idea-refine` (`scripts/`), которые установщик тоже пропустил.
- `.markdownlint-cli2.jsonc`: vendored-каталоги исключены из линта — чужой материал
  не правится под проектный стиль.
- AGENTS.md: скиллы используются в первую очередь внутри фаз (спецификация, кодинг,
  тестирование, ревью); верхнеуровневый процесс 2030ai не меняется; при конфликте
  приоритет за правилами проекта. Решение — ADR `2026-09-07-2350`.

## Зачем

Владелец: использовать эти скиллы при разработке спецификаций, кодинге и тестировании,
сохранив верхнеуровневый процесс 2030ai. Скиллы кодируют технику выполнения фаз,
шаблон 2030ai — артефакты и роли; слои дополняют друг друга. Установка в репозиторий —
для версионирования, воспроизводимости и переноса практик в HBK.SG.

## Обновлено

- [x] .agents/skills/ — 25 скиллов; по 25 симлинков в .claude/.codex/.cursor
- [x] .agents/references/ — общие чек-листы источника; ссылки `../../references/*.md` разрешаются
- [x] skills-lock.json, .markdownlint-cli2.jsonc
- [x] AGENTS.md (раздел Project-Local Skills), README.md (структура)
- [x] agent_docs/adr/2026-09-07-2350-adopt-addyosmani-agent-skills.md, agent_docs/snapshot.md
- [x] `markdownlint-cli2 "**/*.md"` — 0 ошибок

## Следующие шаги

1. Ревью и мерж этого PR, затем ребейз ветки `feat/day2-model-params`.
2. День 2: ревью по скиллу `code-review-and-quality` в дополнение к
   reviewer/compliance, затем PR.
3. С дня 3 — полный цикл: спецификация и план по скиллам до кода.

## Связанные решения

- `agent_docs/adr/2026-09-07-2350-adopt-addyosmani-agent-skills.md`
