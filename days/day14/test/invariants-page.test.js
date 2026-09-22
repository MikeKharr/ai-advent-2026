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

test('карточка формулировщика — элемент лога, но не сообщение', () => {
  // В лог она ставится узлом (`placeDraft`), а в переписку не пишется:
  // `messages` её не знает, и перерисовка лога её не теряет. Отдельным блоком
  // под логом она отнимала высоту у переписки — лог сжимался до 128 px
  // (находка design-review к PR #200).
  assert.match(page, /const draftBox = document\.createElement\('li'\);/)
  assert.match(page, /draftBox\.className = 'draft';/)
  assert.match(page, /const placeDraft = \(\) => \{/)
  assert.match(page, /log\.append\(draftBox\);/)
  assert.equal(
    /<div class="draft" id="draft-box"/.test(page),
    false,
    'отдельного блока между логом и полосой запуска больше нет',
  )
  // И `renderLog` действительно её возвращает после перерисовки.
  assert.match(page, /\n    placeDraft\(\);\n    \$\('restored'\)\.hidden/)
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

// --- Правки по находкам гейтов к PR #200 ---------------------------------

test('«Принять» возвращает фокус в поле, как «Отменить» и «править»', () => {
  // После нажатия фокус уходил на BODY, и клавиатурный обход начинался с
  // начала документа (находка design-review).
  assert.match(page, /input\.focus\(\);\n      announce\(`Инвариант П\$\{data\.invariant\.num\} заведён/)
  assert.match(page, /cancel\.onclick = \(\) => \{\n      closeDraft\(\);\n      input\.focus\(\);/)
})

test('ответ формулировщика доходит до программы чтения', () => {
  // Четыре исхода обязаны прозвучать: оценка, замечание, число вариантов —
  // в область состояния; конфликт и 502 — в область тревоги.
  assert.match(page, /announce\(said\);/)
  assert.match(page, /Формулировщик, ход \$\{draftRound\} из \$\{DRAFT_ROUNDS\}/)
  assert.match(page, /shout\(\s*`Черновик противоречит инварианту П\$\{draft\.conflict\}/)
  assert.match(page, /shout\(\s*`Формулировщик не дал варианта/)
  assert.match(page, /announce\('Отправил формулировщику/)
})

test('у платного хода есть состояние занятости', () => {
  assert.match(page, /const draftPending = \(text\) => \{/)
  assert.match(page, /draftBox\.setAttribute\('aria-busy', 'true'\);/)
  assert.match(page, /draftBox\.removeAttribute\('aria-busy'\);/)
  // Поле на время хода заперто: править нечего, ответ ещё не пришёл.
  assert.match(page, /input\.readOnly = true;/)
  assert.match(page, /input\.readOnly = false;/)
  // И его действительно зовут: правило можно оставить верным и перестать
  // вызывать — следствие будет тем же, признака занятости не появится.
  assert.match(
    page,
    /input\.readOnly = true;\n    draftPending\(text\);/,
    'ход обязан звать draftPending до обращения к серверу',
  )
})

test('«Отправить ещё раз» считается ходом и упирается в предел', () => {
  // Счётчик рос только на удачном ходе, и при устойчивом дефекте инструмента
  // посетитель платил бы неограниченно часто (находка reviewer).
  assert.match(page, /if \(data\.code === 'draft_no_variants'\) \{[\s\S]{0,400}?draftRound \+= 1;/)
  assert.match(page, /again\.disabled = draftRound >= DRAFT_ROUNDS;/)
})

test('пропущенный этап остаётся прочерком, а не становится галочкой', () => {
  // `mark` живёт только у текущего этапа, поэтому пропущенный, став
  // пройденным, получал «✓» — при том что монитор писал «пропущено»
  // (находка design-review).
  const stageMark = loadRule('stageMark')
  assert.equal(stageMark('past', 'skipped'), '–')
  assert.equal(stageMark('now', 'skipped'), '–')
  assert.equal(stageMark('past'), '✓')
  assert.equal(stageMark('now', 'paused'), '‖')
  assert.equal(stageMark('next'), '')
  assert.equal(stageMark('now', null), null)

  // И список пропущенных этапов живёт в состоянии запуска, а не в метке.
  assert.match(page, /const wasSkipped = runState\.skipped\.includes\(n\);/)
  assert.match(page, /d\.outcome === 'skipped'/)
  assert.match(page, /skipped: \[\],/)
})
