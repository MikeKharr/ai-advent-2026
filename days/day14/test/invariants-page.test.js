// Страница дня 14 против её собственного исходника: переключатель режима,
// карточка формулировщика, список инвариантов, пометка на ответе и реплика
// «Ответ не отдан» (ADR 2026-09-22-0827, п. 7).
//
// Проверяется исходный текст страницы и два её правила, взятые оттуда же, —
// как в `page-contract.test.js`: копия правила в тесте доказывала бы только
// представление автора о нём.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const page = readFileSync(join(here, '..', 'public', 'index.html'), 'utf8')

/**
 * Заглушка помощника страницы: правила ниже строят через него абзац. Тест
 * подменяет только его — сама проверяемая логика берётся из исходника.
 */
const draftLine = (cls, text) => ({ cls, text })

/** Правило из живого исходника страницы, а не его копия в тесте. */
const loadRule = (name) => {
  const found = page.match(new RegExp(`\\n\\s*const ${name} = [\\s\\S]*?\\n  \\};\\n`))
  assert.ok(found, `на странице нет правила ${name} — его переименовали или убрали`)
  const body = found[0].trim().replace(new RegExp(`^const ${name} = `), '').replace(/;$/, '')
  return eval(`(${body})`)
}

test('у поля ввода есть переключатель «Сообщение | Инвариант»', () => {
  assert.match(page, /name="mode" value="message" checked/)
  assert.match(page, /name="mode" value="invariant"/)
  // Режим виден до нажатия: подпись кнопки меняется вместе с ним.
  assert.match(page, /button\.textContent = invariant \? 'Проверить формулировку' : 'Спросить'/)
})

test('режим «Инвариант» уходит своим каналом, а не сообщением', () => {
  assert.match(
    page,
    /if \(modeOf\(\) === 'invariant'\) return submitDraft\(message\)/,
    'ход формулировщика не должен идти через шесть этапов',
  )
  assert.match(page, /fetch\('\.\/api\/invariants\/draft'/)
  assert.match(page, /fetch\('\.\/api\/invariants'/)
})

test('карточка формулировщика живёт под логом, а не в переписке', () => {
  // В лог она не пишется: `renderLog` её не трогает, и `syncChat` не стирает.
  assert.match(page, /<div class="draft" id="draft-box" hidden><\/div>/)
  assert.equal(/pushLocal\('draft'/.test(page), false)
})

test('принять можно только формулировку с билетом', () => {
  // Билет уходит в тело приёма: без него сервис отвечает 400.
  assert.match(page, /body: JSON\.stringify\(\{ text, ticket \}\)/)
  // Кнопка «Принять» строится только там, где билет есть.
  assert.match(page, /if \(draft\.verdict === 'ok' && draft\.ticket\) offer\(draft\.text, draft\.ticket/)
  assert.match(page, /for \(const variant of draft\.variants \?\? \[\]\) offer\(variant\.text, variant\.ticket/)
})

test('третий ход закрывает правку, оставляя кнопки вариантов и «Отменить»', () => {
  assert.match(page, /const DRAFT_ROUNDS = 3;/)
  assert.match(page, /const last = draftRound >= DRAFT_ROUNDS;/)
  assert.match(page, /if \(!last\) \{/)
})

test('ответ без варианта назван дефектом инструмента и оплаченным ходом', () => {
  assert.match(page, /data\.code === 'draft_no_variants'/)
  assert.match(page, /ход оплачен и слот дневного лимита занят/)
  assert.match(page, /Отправить ещё раз/)
})

test('реплика «Ответ не отдан» несёт номер, текст и круг', () => {
  const withheldText = loadRule('withheldText')
  assert.equal(
    withheldText({
      invariants: [2],
      texts: ['Отвечай не длиннее пяти предложений'],
      remarks: 'ответ на семь абзацев',
      round: 2,
      rounds: 2,
    }),
    'Ответ не отдан: нарушает инвариант профиля П2 «Отвечай не длиннее пяти предложений» ' +
      '(круг 2 из 2).\nЗамечания проверки: ответ на семь абзацев',
  )
  // Карточки ответа под такой репликой нет: ответа не существует.
  assert.match(page, /if \(meta\.withheld\) \{/)
})

test('пометка инвариантов не выдаёт мнение модели за доказательство', () => {
  const addInvariants = loadRule('addInvariants')
  const held = []
  addInvariants({ append: (x) => held.push(x) }, { invariants: { checked: [1, 3], status: 'held' } })
  assert.equal(held.length, 1)
  assert.match(held[0].text, /П1, П3/)
  assert.match(held[0].text, /это её мнение, не доказательство/)

  const unchecked = []
  addInvariants(
    { append: (x) => unchecked.push(x) },
    { invariants: { checked: [1], status: 'unchecked' } },
  )
  assert.match(unchecked[0].text, /не проверены/)

  // Профиль без инвариантов пометки не несёт вовсе.
  const none = []
  addInvariants({ append: (x) => none.push(x) }, { invariants: { checked: [], status: 'unchecked' } })
  assert.deepEqual(none, [])
  addInvariants({ append: (x) => none.push(x) }, {})
  assert.deepEqual(none, [])
})

test('список инвариантов в окне памяти даёт удаление и говорит о дырах', () => {
  assert.match(page, /<div id="mem-invariants"><\/div>/)
  assert.match(page, /fetch\(`\.\/api\/invariants\/\$\{item\.num\}`, \{ method: 'DELETE' \}\)/)
  assert.match(page, /Номер удалённого инварианта не переиспользуется/)
  assert.match(page, /с нарушением не отдаётся/)
})

test('промпт формулировщика показан в «Об агенте» и приходит от сервиса', () => {
  assert.match(page, /id="dlg-draft"/)
  assert.match(page, /const text = invariantLimits\?\.prompt \?\? null;/)
  assert.match(page, /if \(d\.invariants\) invariantLimits = \{ \.\.\.invariantLimits, \.\.\.d\.invariants \};/)
})
