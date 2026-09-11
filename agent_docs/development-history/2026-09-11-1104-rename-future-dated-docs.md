# [2026-09-11 11:04] Имена документов — по реальному времени мержа, UTC

Файл: `agent_docs/development-history/2026-09-11-1104-rename-future-dated-docs.md`

## Что сделано

PR 2 из трёх по ADR `2026-09-11-1046` о датах в именах атомарных
документов (PR #109, принят владельцем 2026-09-11: переименовать + починить правило,
зона UTC, даты в текстах — на реальные, 17 документов 07–08.09 не трогать).

- **Переименование.** 57 файлов (48 старых идентификаторов) в `adr/`,
  `development-history/`, `design/` — от PR #29 включительно, имя позже
  мержа — получили имя `YYYY-MM-DD-HHMM` по времени мержа своего PR в
  `main`, UTC (`git log --first-parent --diff-filter=A`, время коммита
  сквоша). Несколько файлов одного PR — по минуте в прежнем порядке имён;
  файлы одного PR с общим старым идентификатором (ADR и запись истории
  #33, #35; ADR и проект решения атласа #50) получили общий новый — пары
  остались парами. `git mv`, история файлов сохранена. Раскладка дня 6
  без времени в имени получила время.
- **Ссылки.** 585 вхождений новых идентификаторов в 139 файлах: полные
  имена, голые идентификаторы, адреса вида `#adr-…`, ключи
  `atlas/overlay.json`, примеры в тестах и подсказках атласа, комментарии
  в коде дней 5–8, `agents/`, `router/`, `deploy/` и `.gitignore`. Шесть
  старых идентификаторов после переименования ведут в два разных новых
  (запись истории и раскладка или ADR из разных PR — в таблице такие
  старые имена повторяются); девять голых упоминаний без имени файла
  разобраны по смыслу вручную.
- **Даты в текстах** (разовое исключение из I-12 по ADR: только пути,
  идентификаторы и даты, суть не тронута). H1 `[…]` у 35 файлов — по новому
  имени. Строки `Дата:` и даты решения владельца в статусах 8 ADR — на
  дату мержа по UTC: агент как сервис и свой промпт дня 6, дни 7 и 8 —
  `2026-09-09`; фреймворк v2 (с поправкой #48) и атлас — `2026-09-10`; два
  ADR дня 5 (#29, 01:24 по UTC+7) — `2026-09-08`, чтобы совпасть с именем.
  В `snapshot.md`: фреймворк v2 внедрён `2026-09-10`, день 8 выкачен
  `2026-09-09` (выкатка 21:33 UTC), решение о общем бюджете — `2026-09-09`;
  в `backlog.md`: «поставлено владельцем» — `2026-09-09`.
- **Прочие даты событий из будущего** (по ревью #110, дата — по мержу
  PR, где строка появилась, или по выкатке): в ADR фреймворка v2 задание и
  уточнение владельца — `2026-09-10`; в ADR дня 8 решение о бюджете —
  `2026-09-09`; в `backlog-closed.md` закрытия этапов атласа 1–3 —
  `2026-09-10`, выкатка дня 7 — `2026-09-09`; в раскладках замер на
  сервере, расчёт контраста и снимки пути посещений — `2026-09-10`, коммит
  343de3c — `10.09.2026`, примеры подписей узлов и диапазона дат — по
  новым ключам; в записях истории дней 7 и 8 выкатка — `2026-09-09`, в
  записи фреймворка v2 проверка — `2026-09-10`; комментарий-пример в
  `atlas/web/app.js`. Не тронуты: `design/2026-09-10-1553-progress-page.md`
  (строка описывает прежние `data-date` лендинга), примеры формата в тестах
  и комментариях атласа.
- **Главная.** `data-date` дня 5 — `08.09`, дней 6–8 — `09.09` (мерж их PR
  по UTC); даты узлов дней в атласе поменялись вместе с ними.
- **Правило на будущее** в `guides/atomic-documents.md`, README `adr/` и
  `development-history/`, шаблонах: имя из `date -u +%Y-%m-%d-%H%M` в
  момент создания, занято — следующая минута, H1 повторяет имя, порядок —
  следствие времени, а не цель.

## Зачем

Имена «проектных часов» ушли вперёд реального времени на 8–88 часов, и
атлас, vault и лендинг показывали посетителю даты 12–14 сентября у
документов 9–11 сентября. Причины и масштаб — в ADR (PR #109).

## Проверки

- `node atlas/build.js --check` — ссылки разрешаются, находок нет
  (207 узлов, 856 рёбер).
- `node --test atlas/test/*.test.js` — 316 из 316;
  `node --test test/*.test.js` — 37 из 37. В `web.test.js` поправлены три
  ожидания `shortName`: подпись узла выводится из имени.
- markdownlint — 0 находок.
- Поиск 48 старых идентификаторов по репозиторию — вхождения только в
  таблице ниже и в самом ADR о датах (`agent_docs/adr/2026-09-11-1046-atomic-document-dates.md`):
  там старые имена — предмет описания (таблица расхождений, цитата
  допущения 1, пример адреса витрины), и они оставлены. Переписаны только
  четыре его ссылки на файлы — ADR SDLC и раскладка страницы прогресса.

## Не сделано здесь

- Проверка «дата не в будущем» в `docs-guard` и пункт 1 роли `docs` — PR 3.
- Описания старых PR на GitHub и сообщение коммита #96 не правились:
  ключ к ним — таблица ниже.

## Старое имя → новое

| Каталог | PR | Старое имя | Новое имя |
|---|---|---|---|
| `adr` | #29 | `2026-09-09-1100-explicit-model-choice` | `2026-09-08-1824-explicit-model-choice` |
| `adr` | #29 | `2026-09-09-1130-day5-article-archive` | `2026-09-08-1825-day5-article-archive` |
| `development-history` | #29 | `2026-09-09-1200-day5-archive-and-model-choice` | `2026-09-08-1826-day5-archive-and-model-choice` |
| `development-history` | #31 | `2026-09-09-2100-groq-input-limit` | `2026-09-09-0035-groq-input-limit` |
| `adr` | #33 | `2026-09-09-2330-live-provider-quota` | `2026-09-09-0156-live-provider-quota` |
| `development-history` | #33 | `2026-09-09-2330-live-quota` | `2026-09-09-0156-live-quota` |
| `development-history` | #35 | `2026-09-09-2400-mac-tailnet` | `2026-09-09-0258-mac-tailnet` |
| `adr` | #35 | `2026-09-09-2400-tailscale-to-laptop` | `2026-09-09-0258-tailscale-to-laptop` |
| `adr` | #37 | `2026-09-10-1000-agent-service` | `2026-09-09-0854-agent-service` |
| `design` | #37 | `2026-09-10-day6-monitor-layout` | `2026-09-09-0855-day6-monitor-layout` |
| `development-history` | #39 | `2026-09-10-1700-day6-agent-service` | `2026-09-09-1535-day6-agent-service` |
| `design` | #41 | `2026-09-11-0900-day6-prompt-and-feed` | `2026-09-09-1622-day6-prompt-and-feed` |
| `adr` | #41 | `2026-09-11-0930-editable-system-prompt` | `2026-09-09-1623-editable-system-prompt` |
| `development-history` | #41 | `2026-09-11-1200-day6-prompt-and-feed` | `2026-09-09-1624-day6-prompt-and-feed` |
| `design` | #43 | `2026-09-12-0900-day7-chat-layout` | `2026-09-09-1905-day7-chat-layout` |
| `adr` | #43 | `2026-09-12-0930-day7-chat-sessions` | `2026-09-09-1906-day7-chat-sessions` |
| `development-history` | #43 | `2026-09-12-1400-day7-chat-memory` | `2026-09-09-1907-day7-chat-memory` |
| `design` | #45 | `2026-09-13-0900-day8-chat-refinements` | `2026-09-09-2133-day8-chat-refinements` |
| `adr` | #45 | `2026-09-13-0930-day8-relevance-from-dialogue` | `2026-09-09-2134-day8-relevance-from-dialogue` |
| `development-history` | #45 | `2026-09-13-1500-day8-dialogue-relevance` | `2026-09-09-2135-day8-dialogue-relevance` |
| `adr` | #47 | `2026-09-13-1800-framework-v2-model-routing` | `2026-09-10-0426-framework-v2-model-routing` |
| `development-history` | #47 | `2026-09-13-1900-framework-v2` | `2026-09-10-0427-framework-v2` |
| `adr` | #50 | `2026-09-13-2000-project-atlas` | `2026-09-10-0550-project-atlas` |
| `design` | #50 | `2026-09-13-2000-project-atlas` | `2026-09-10-0550-project-atlas` |
| `development-history` | #53 | `2026-09-13-2100-atlas-stages-1-2` | `2026-09-10-0806-atlas-stages-1-2` |
| `design` | #54 | `2026-09-13-2100-atlas-page-layout` | `2026-09-10-1155-atlas-page-layout` |
| `development-history` | #55 | `2026-09-13-2300-atlas-stage-3` | `2026-09-10-1240-atlas-stage-3` |
| `development-history` | #57 | `2026-09-13-2330-atlas-stage-4` | `2026-09-10-1338-atlas-stage-4` |
| `adr` | #58 | `2026-09-14-1000-atlas-3d-graph` | `2026-09-10-1420-atlas-3d-graph` |
| `design` | #60 | `2026-09-14-1200-atlas-3d-mode` | `2026-09-10-1517-atlas-3d-mode` |
| `design` | #62 | `2026-09-14-0900-atlas-visit-trail` | `2026-09-10-1548-atlas-visit-trail` |
| `design` | #63 | `2026-09-14-1300-progress-page` | `2026-09-10-1553-progress-page` |
| `development-history` | #66 | `2026-09-14-1230-atlas-3d-decision-data-layout` | `2026-09-10-1602-atlas-3d-decision-data-layout` |
| `development-history` | #66 | `2026-09-14-1400-atlas-visit-trail` | `2026-09-10-1603-atlas-visit-trail` |
| `development-history` | #66 | `2026-09-14-1430-progress-page` | `2026-09-10-1604-progress-page` |
| `development-history` | #67 | `2026-09-14-1500-atlas-label-placement` | `2026-09-10-1750-atlas-label-placement` |
| `design` | #72 | `2026-09-14-1500-atlas-focus-after-step` | `2026-09-10-1756-atlas-focus-after-step` |
| `development-history` | #74 | `2026-09-14-1530-atlas-3d-mode-prod` | `2026-09-11-0042-atlas-3d-mode-prod` |
| `development-history` | #74 | `2026-09-14-1600-ci-detect-last-deploy` | `2026-09-11-0043-ci-detect-last-deploy` |
| `development-history` | #74 | `2026-09-14-1630-atlas-routes-edges-vault` | `2026-09-11-0044-atlas-routes-edges-vault` |
| `development-history` | #76 | `2026-09-14-1700-ci-deploy-unit-allowlist` | `2026-09-11-0123-ci-deploy-unit-allowlist` |
| `development-history` | #76 | `2026-09-14-1730-atlas-focus-after-step` | `2026-09-11-0124-atlas-focus-after-step` |
| `development-history` | #79 | `2026-09-14-1800-ci-deploy-hardening` | `2026-09-11-0147-ci-deploy-hardening` |
| `design` | #80 | `2026-09-14-1700-atlas-tab-order` | `2026-09-11-0207-atlas-tab-order` |
| `design` | #81 | `2026-09-14-1730-atlas-load-error` | `2026-09-11-0153-atlas-load-error` |
| `development-history` | #83 | `2026-09-14-1830-atlas-load-false-error-flaky-test` | `2026-09-11-0214-atlas-load-false-error-flaky-test` |
| `development-history` | #83 | `2026-09-14-1900-atlas-load-error-tab-order-layouts` | `2026-09-11-0215-atlas-load-error-tab-order-layouts` |
| `design` | #86 | `2026-09-14-1930-atlas-load-timeout` | `2026-09-11-0240-atlas-load-timeout` |
| `development-history` | #90 | `2026-09-14-2000-ci-unit-names-z-matrix-env` | `2026-09-11-0320-ci-unit-names-z-matrix-env` |
| `development-history` | #90 | `2026-09-14-2030-atlas-load-error-code-timeout-layout` | `2026-09-11-0321-atlas-load-error-code-timeout-layout` |
| `development-history` | #93 | `2026-09-14-2100-atlas-frozen-load-timeout-code` | `2026-09-11-0428-atlas-frozen-load-timeout-code` |
| `adr` | #95 | `2026-09-14-2200-sdlc-autonomy` | `2026-09-11-0513-sdlc-autonomy` |
| `development-history` | #96 | `2026-09-14-2230-sdlc-autonomy-process` | `2026-09-11-0541-sdlc-autonomy-process` |
| `design` | #101 | `2026-09-14-2300-atlas-3d-fullgraph-search` | `2026-09-11-0726-atlas-3d-fullgraph-search` |
| `adr` | #102 | `2026-09-14-2330-atlas-3d-fullgraph-search` | `2026-09-11-0745-atlas-3d-fullgraph-search` |
| `development-history` | #107 | `2026-09-14-2300-home-is-progress-page` | `2026-09-11-0903-home-is-progress-page` |
| `development-history` | #107 | `2026-09-14-2330-atlas-fullgraph-search` | `2026-09-11-0904-atlas-fullgraph-search` |
