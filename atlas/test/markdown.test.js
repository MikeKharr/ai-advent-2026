import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  atomicId,
  clip,
  firstParagraph,
  heading,
  parseFrontmatter,
  replacementRefs,
  scanCitations,
  section,
} from '../lib/markdown.js'

test('фронтматтер роли читает модель, усилие и список скиллов', () => {
  const { data, body } = parseFrontmatter(
    '---\nname: backend\nmodel: opus\neffort: medium\nskills:\n  - a\n  - b\n---\n# Backend\n',
  )
  assert.deepEqual(data, { name: 'backend', model: 'opus', effort: 'medium', skills: ['a', 'b'] })
  assert.equal(heading(body), 'Backend')
})

test('раздел берётся до следующего заголовка того же уровня', () => {
  const text = '# T\n\n## Статус\n\nПринято\n\n## Контекст\n\nПервый абзац.\nЕго продолжение.\n\nВторой.\n'
  assert.equal(section(text, 'Статус'), 'Принято')
  assert.equal(firstParagraph(section(text, 'Контекст')), 'Первый абзац. Его продолжение.')
})

test('выдержка обрезается по границе слова', () => {
  assert.equal(clip('раз два три', 8), 'раз два…')
  assert.equal(clip('коротко', 80), 'коротко')
})

test('цитата ADR разбирается и в форме id, и в форме имени файла', () => {
  const found = scanCitations('ADR `2026-09-07-1525` и ADR `2026-09-08-0205-skill-install-security-gate.md`')
  const adr = found.filter((f) => f.kind === 'adr').map((f) => f.value)
  assert.deepEqual(adr, ['2026-09-07-1525', '2026-09-08-0205'])
})

test('заглушки шаблонов цитатами не считаются', () => {
  const found = scanCitations('шаблон `agent_docs/adr/YYYY-MM-DD-HHMM-title.md`, ADR `YYYY-MM-DD-HHMM`')
  assert.deepEqual(found.filter((f) => f.kind === 'adr' || f.kind === 'path'), [])
})

test('пути к документам нормализуются без префикса agent_docs', () => {
  const found = scanCitations('см. `agent_docs/guides/dod.md` и `development-history/2026-09-08-1245`')
  assert.deepEqual(
    found.filter((f) => f.kind === 'path').map((f) => f.value),
    ['guides/dod.md', 'development-history/2026-09-08-1245'],
  )
})

test('номер строки в находке — настоящий', () => {
  const found = scanCitations('строка один\n\nADR `2026-09-07-1525`\n')
  assert.equal(found.find((f) => f.kind === 'adr').line, 3)
})

test('инвариант распознаётся, а часть слова — нет', () => {
  const found = scanCitations('инвариант I-4 и I-12; не AI-1 и не 2026-09-13')
  assert.deepEqual(
    found.filter((f) => f.kind === 'invariant').map((f) => f.value),
    ['I-4', 'I-12'],
  )
})

test('строки замены читаются только из раздела «Статус»', () => {
  const text =
    '# T\n\n## Статус\n\nПринято. Заменяет `agent_docs/adr/2026-09-07-1535-vps-vultr-singapore.md`\n\n' +
    '## Контекст\n\n| Потребность | Заменяет `2026-01-01-0000` |\n'
  assert.deepEqual(replacementRefs(text), { replaces: ['2026-09-07-1535'], replacedBy: [] })
})

test('«Заменено на» отличается от «Заменяет»', () => {
  const text = '# T\n\n## Статус\n\nЗаменено на `2026-09-07-2016-feed-based-digest.md`\n'
  assert.deepEqual(replacementRefs(text), { replaces: [], replacedBy: ['2026-09-07-2016'] })
})

test('идентификатор атомарного документа вынимается из имени файла', () => {
  assert.equal(atomicId('2026-09-13-1800-framework-v2-model-routing.md'), '2026-09-13-1800')
  assert.equal(atomicId('corpus.md'), null)
})
