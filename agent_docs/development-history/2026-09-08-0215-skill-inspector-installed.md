# [2026-09-08 02:15] Гейт безопасности скиллов: SkillSpector + skill-inspector

Файл: `agent_docs/development-history/2026-09-08-0215-skill-inspector-installed.md`

## Что сделано

- Установлен CLI `skillspector` v2.11.1 (NVIDIA SkillSpector) на машину разработчика
  через `uv tool install` с пином `@704bc95` (uv поставлен через Homebrew); LLM-стадия
  сканера не используется (обоснование — ADR, п. 3 Решения), семантическую линию
  выполняет агент.
- Установлен скилл `skill-inspector` (NVIDIA/SkillSpector, пин `704bc95`) в
  `.agents/skills/` с зеркалами `.claude`/`.codex`/`.cursor`; файл побайтово сверен
  с upstream. Перед установкой прогнан через сам гейт: 37/MEDIUM, рекомендация
  сканера `CAUTION`, два HIGH `AE1` — самоссылки чек-листа, источник — один
  read-only markdown; вердикт `CAUTION` с объяснёнными находками, установка разрешена.
- В AGENTS.md (Project-Local Skills) закреплён обязательный гейт перед установкой
  или обновлением любого стороннего скилла: статический скан + семантическое ревью,
  вердикты `APPROVE`/`CAUTION`/`REJECT`, итог — в PR установки
  (ADR `2026-09-08-0205-skill-install-security-gate.md`).
- `guides/environment-setup.md`: как поставить CLI на новой машине.

## Зачем

Поручение владельца: установить скиллы NVIDIA, проверяющие рискованность установки
скиллов, и закрепить обязательную проверку перед установкой в схеме высшего уровня.
Скиллы исполняются с полными правами агента — это supply chain, и набор addyosmani
ставился до появления гейта без проверки на вредоносные паттерны.

## Ретроспективный скан набора addyosmani (25 скиллов, SkillSpector 2.11.1, `--no-llm`)

| Скилл | Счёт | Рекомендация сканера |
|---|---:|---|
| security-and-hardening | 76 | DO_NOT_INSTALL |
| browser-testing-with-devtools | 65 | DO_NOT_INSTALL |
| source-driven-development | 47 | CAUTION |
| context-engineering | 33 | CAUTION |
| ci-cd-and-automation, shipping-and-launch | 27 | CAUTION |
| остальные 19 | 0–23 | SAFE/CAUTION |

Каждая HIGH-находка набора (в десяти скиллах, включая оба «DO_NOT_INSTALL»)
прочитана в источнике и объяснена — построчный разбор в ADR, раздел
«Ретроспективный скан». Общая картина: срабатывания на защитную документацию
и на упоминания чувствительных понятий в поучительном контексте; исполняемых
файлов, сети, установок нет. Ретро-вердикт: набор остаётся, `CAUTION`
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
