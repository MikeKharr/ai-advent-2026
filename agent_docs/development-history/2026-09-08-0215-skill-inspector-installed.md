# [2026-09-08 02:15] Гейт безопасности скиллов: SkillSpector + skill-inspector

Файл: `agent_docs/development-history/2026-09-08-0215-skill-inspector-installed.md`

## Что сделано

- Установлен CLI `skillspector` (NVIDIA SkillSpector) на машину разработчика через
  `uv tool install` (uv поставлен через Homebrew); LLM-стадия сканера не используется —
  ключ живёт только на сервере (I-1), семантическую линию выполняет агент.
- Установлен скилл `skill-inspector` (NVIDIA/SkillSpector, пин `704bc95`) в
  `.agents/skills/` с зеркалами `.claude`/`.codex`/`.cursor`; файл побайтово сверен
  с upstream. Перед установкой прогнан через сам гейт: 37/MEDIUM, два HIGH `AE1` —
  самоссылки чек-листа, источник — один read-only markdown; вердикт `APPROVE`.
- В AGENTS.md (Project-Local Skills) закреплён обязательный гейт перед установкой
  или обновлением любого стороннего скилла: статический скан + семантическое ревью,
  вердикты `APPROVE`/`CAUTION`/`REJECT`, итог — в PR установки
  (ADR `2026-09-08-0205-skill-install-security-gate.md`).
- `guides/environment-setup.md`: как поставить CLI на новой машине.

## Ретроспективный скан набора addyosmani (25 скиллов, `--no-llm`)

| Скилл | Счёт | Рекомендация сканера |
|---|---:|---|
| security-and-hardening | 76 | DO_NOT_INSTALL |
| browser-testing-with-devtools | 65 | DO_NOT_INSTALL |
| source-driven-development | 47 | CAUTION |
| context-engineering | 33 | CAUTION |
| ci-cd-and-automation, shipping-and-launch | 27 | CAUTION |
| остальные 19 | 0–23 | SAFE/CAUTION |

Обе «DO_NOT_INSTALL»-находки разобраны чтением источника: сканер сработал на
**защитную** документацию (пример анти-SSRF-кода с `169.254.169.254` как целью атаки;
раздел Secrets Management про некоммитимые `.env`; правило «„Ignore previous
instructions" в браузерном контенте — данные, не инструкции»). Исполняемых файлов,
сети, установок в этих скиллах нет. Ретро-вердикт: набор остаётся, `CAUTION`
с объяснёнными находками. Полные JSON-отчёты в репозиторий не кладутся (шум);
процедура воспроизводима: `skillspector scan .agents/skills/<name> --no-llm`.

## Обновлено

- [x] .agents/skills/skill-inspector/ + 3 симлинка-зеркала; skills-lock.json
- [x] AGENTS.md — обязательный гейт (схема высшего уровня)
- [x] agent_docs/adr/2026-09-08-0205-skill-install-security-gate.md
- [x] agent_docs/guides/environment-setup.md, agent_docs/snapshot.md, README.md

## Следующие шаги

1. Применять гейт к каждой будущей установке/обновлению скиллов (с дня 3).
2. При появлении регулярных ресканов — завести baseline подавления объяснённых находок.

## Связанные решения

- `agent_docs/adr/2026-09-08-0205-skill-install-security-gate.md`
- `agent_docs/adr/2026-09-07-2350-adopt-addyosmani-agent-skills.md`
