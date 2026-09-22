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

/** Склонение со страницы: правило ниже строит фразу через него. */
const plural = (n, one, few, many) => {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}
const DRAFT_ROUNDS = 3

/**
 * Значение объявления со страницы, а не его копия в тесте: копия доказывала бы
 * число, а не источник — подмена `roundLimits.max` на готовую тройку прошла бы
 * тест молча (находка reviewer к PR #204).
 */
const valueSource = (name) => {
  const found = page.match(new RegExp(`\\n\\s*(?:let|const) ${name} = (.*?);\\n`))
  assert.ok(found, `на странице нет объявления ${name} — его переименовали или убрали`)
  return found[1]
}
const loadValue = (name) => eval(`(${valueSource(name)})`)
const roundLimits = loadValue('roundLimits')

/**
 * Исходный текст правила со страницы. Отдельно от `loadRule`, потому что
 * правилу, которому нужны помощники самого теста (объявления, длительность,
 * состояние полосы), `eval` нужен в области теста, а не здесь.
 */
const ruleSource = (name) => {
  const found = page.match(new RegExp(`\\n\\s*const ${name} = [\\s\\S]*?\\n  \\};\\n`))
  assert.ok(found, `на странице нет правила ${name} — его переименовали или убрали`)
  return found[0].trim().replace(new RegExp(`^const ${name} = `), '').replace(/;$/, '')
}

/** Правило из живого исходника страницы, а не его копия в тесте. */
const loadRule = (name) => eval(`(${ruleSource(name)})`)

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

test('под «не отдан» названы три выхода, и каждый говорит, где он делается', () => {
  const withheldExits = loadRule('withheldExits')
  const made = withheldExits({ invariants: [4], round: 1, rounds: 1 })
  assert.equal(made.length, 4, 'объяснение и три выхода')
  assert.ok(
    made.every((p) => p.cls === 'ask-note'),
    'выходы идут тем же абзацем, что и прочие пояснения лога',
  )
  const lines = made.map((p) => p.text)
  // 1. Спросить иначе — и почему просто повторить нельзя.
  assert.match(lines[0], /тот же исход и ту же трату/)
  assert.match(lines[1], /Спросить иначе/)
  assert.match(lines[1], /П4/)
  // 2. Инвариант — с местом, где он правится.
  assert.match(lines[2], /Смягчить или удалить П4/)
  assert.match(lines[2], /«Память профиля»/)
  // 3. Предел кругов — с местом и с тем, что это даст. Названо то, что видно:
  // имя шестерёнки живёт только в `aria-label`, видимого текста на экране нет.
  assert.match(lines[3], /Поднять предел кругов — сейчас 1/)
  // Слово нейтральное: в значке восемь прямых лучей, зубцов шестерёнки нет
  // (замер design-review к PR #204).
  assert.match(lines[3], /значок настроек у левого края/)
  assert.equal(/шестерёнк/i.test(lines[3]), false)
  assert.match(lines[3], /окно «Настройки агента»/)
  assert.match(lines[3], /замечания проверки и попробует ещё раз/)
  // Потолок кругов берётся у сервиса, а не вписан числом.
  assert.match(page, /rounds < roundLimits\.max/)

  // И карточка собирается именно этим правилом.
  assert.match(page, /li\.append\(\.\.\.withheldExits\(meta\.withheld\)\);/)
})

test('на потолке кругов выходов названо два — столько же, сколько дано', () => {
  const withheldExits = loadRule('withheldExits')
  const atCap = withheldExits({ invariants: [2], round: 3, rounds: roundLimits.max })
  const lines = atCap.map((p) => p.text)
  assert.match(lines[3], new RegExp(`Предел кругов уже ${roundLimits.max} — выше не поднять`))
  // Счёт подчинён тому же условию, что и третий выход: обещать три и дать два
  // нельзя (находка design-review к PR #204).
  assert.match(lines[0], /выходов два/)
  assert.equal(/выходов три/.test(lines[0]), false)
  // А пока предел есть куда поднимать — выходов действительно три.
  const room = withheldExits({ invariants: [2], round: 1, rounds: roundLimits.min })
  assert.match(room[0].text, /выходов три/)
})

test('выходы зовут инвариант инвариантом, а не правилом', () => {
  // В окне «Память профиля» это два разных раздела, и различие несущее:
  // правило из разговора можно не соблюсти — ответ отдадут с пометкой,
  // инвариант нельзя (находка design-review к PR #204).
  const withheldExits = loadRule('withheldExits')
  for (const w of [
    { invariants: [1], round: 1, rounds: 1 },
    { invariants: [1, 2], round: 3, rounds: 3 },
  ]) {
    for (const p of withheldExits(w)) {
      assert.equal(/правил/i.test(p.text), false, `слово «правило» в выходе: ${p.text}`)
    }
  }
  // Номеров бывает несколько, и число согласовано с ними.
  const one = withheldExits({ invariants: [1], round: 1, rounds: 1 }).map((p) => p.text)
  assert.match(one[0], /назвала нарушенный инвариант профиля П1 на последнем круге/)
  const two = withheldExits({ invariants: [1, 2], round: 1, rounds: 1 }).map((p) => p.text)
  assert.match(two[0], /назвала нарушенные инварианты профиля П1, П2 на последнем круге/)
  assert.match(two[1], /не упирался в П1, П2/)
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
  // Фразу строит отдельное правило — его содержание проверено ниже; здесь
  // важно, что отрисовка действительно его зовёт и объявляет результат.
  assert.match(page, /const said = draftSaid\(draft, draftRound, last\);/)
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

test('неотданный запуск не объявляется как «готово»', () => {
  // Объявление и полоса — единственное, что слышит программа чтения: выходы
  // лежат в логе, а он живой областью не является (находка design-review
  // к PR #204). Правило исполняется, а не ищется регуляркой: подменены только
  // помощники страницы.
  const said = []
  const announce = (text) => said.push(text)
  const fmtDuration = () => '15,1 с'
  const STATUS_WORD = { queued: 'в очереди', running: 'идёт' }
  const setStatus = eval(`(${ruleSource('setStatus')})`)

  setStatus({ name: 'Спросил', status: 'running', warnings: 0, withheld: true }, 'succeeded')
  assert.equal(said.length, 1)
  assert.match(said[0], /ответ не отдан за 15,1 с/)
  assert.equal(/готово/i.test(said[0]), false, '«готово» при неотданном ответе — враньё')
  assert.match(said[0], /объяснение и выходы в переписке/)

  // Обычный удачный запуск объявляется по-прежнему.
  setStatus({ name: 'Спросил', status: 'running', warnings: 0 }, 'succeeded')
  assert.match(said[1], /готово за 15,1 с/)
  void announce, void fmtDuration, void STATUS_WORD
})

test('полоса при неотданном ответе говорит «Ответ не отдан», а не «Готово»', () => {
  const stages = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, title: `Этап ${i}` }))
  const fmtDuration = () => '15,1 с'
  let elapsedMs = 0
  const PAUSE_TTL_MIN = 60
  let runState = { view: 'done', done: 6, durationMs: 15100, withheld: true }
  const runStateText = eval(`(${ruleSource('runStateText')})`)
  assert.equal(runStateText(), 'Ответ не отдан · 6 этапов · 15,1 с')
  runState = { view: 'done', done: 6, durationMs: 15100, withheld: false }
  assert.equal(runStateText(), 'Готово · 6 этапов · 15,1 с')
  void elapsedMs, void PAUSE_TTL_MIN, void stages
})

test('«Выдача» при неотданном ответе несёт «×», а не галочку', () => {
  const stageMark = loadRule('stageMark')
  const stages = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, title: `Этап ${i}` }))
  let runState = { withheld: true, skipped: [5], mark: null }
  const isWithheldStage = eval(`(${valueSource('isWithheldStage')})`)
  const stageSign = eval(`(${ruleSource('stageSign')})`)
  // Знак и приглушение идут от одного условия: разойдясь, они дали бы
  // крестик без приглушения (нит reviewer к PR #204).
  assert.match(page, /const withheldHere = isWithheldStage\(n\);/)
  void isWithheldStage
  // Шестая — «Выдача»: этап состоялся, но отдавать было нечего.
  assert.equal(stageSign(6, 'past'), '×')
  // Пятая — пополнение памяти, пропущенное целиком: прочерк, как и был.
  assert.equal(stageSign(5, 'past'), '–')
  assert.equal(stageSign(1, 'past'), '✓')
  // Отданный ответ ничего не меняет.
  runState = { withheld: false, skipped: [], mark: null }
  assert.equal(stageSign(6, 'past'), '✓')
  void stageMark, void stages
})

test('признак «ответ не отдан» доведён от результата до полосы', () => {
  // Правила выше проверяются с подставленным состоянием, поэтому проводка
  // нуждается в своём стороже: без неё правила живы, а экран возвращается к
  // «Готово», и ничто не краснеет (находка reviewer к PR #204).

  // 1. Результат запуска ставит признак — рядом с показом объяснения.
  assert.match(
    page,
    /if \(r\.withheld\) \{[\s\S]{0,400}?run\.withheld = true;[\s\S]{0,200}?answered\(withheldText\(r\.withheld\)/,
    'результат с `withheld` обязан ставить признак запуска',
  )
  // 2. Завершение переносит его в полосу.
  assert.match(page, /withheld: run\.withheld === true,/)
  assert.match(
    page,
    /const finishRun = \(run, view = 'done'\) => \{[\s\S]*?withheld: run\.withheld === true,/,
    'перенос живёт именно в завершении запуска',
  )
  // 3. Старт своего запуска начинает с чистой «Выдачи».
  assert.match(
    page,
    /setRunView\('running', \{[\s\S]{0,400}?withheld: false,/,
    'новый запуск обязан начинаться без признака',
  )
})

test('объявление на настоящем порядке событий: событие выдачи опережает результат', () => {
  // Событие `done` со статусом «успешно» приходит РАНЬШЕ результата потока, и
  // объявление делается на нём. Прежде фраза про неотданный ответ не
  // произносилась никогда: второй вызов `setStatus` выходил на
  // `run.status === status` (находка design-review к PR #204). Поэтому тест
  // прогоняет цепочку `addEvent` → `setStatus`, а не подставляет состояние.
  const said = []
  const announce = (text) => said.push(text)
  const fmtDuration = () => '15,1 с'
  const shout = () => {}
  const renderMonitor = () => {}
  const trackRun = () => true
  const STATUS_WORD = { queued: 'в очереди', running: 'выполняется', succeeded: 'готово' }
  const setStatus = eval(`(${ruleSource('setStatus')})`)
  const addEvent = eval(`(${ruleSource('addEvent')})`)

  const run = {
    name: 'Спросил', status: 'running', warnings: 0, events: [],
    durationMs: null, startedAt: new Date().toISOString(),
  }
  // Ровно то событие, что шлёт служба: заголовок и номера в данных.
  addEvent(run, {
    stage: 'done',
    title: 'Ответ не отдан: нарушен инвариант профиля',
    status: 'succeeded',
    durationMs: 15100,
    data: { state: 'deliver', rounds: 1, withheld: [1] },
  })
  assert.equal(said.length, 1, 'объявление делается на событии выдачи')
  assert.match(said[0], /ответ не отдан за 15,1 с/)
  assert.equal(/готово/i.test(said[0]), false, '«готово» при неотданном ответе — враньё')

  // И карточка монитора берёт слово оттуда же.
  const plural = () => ''
  const runHeader = eval(`(${ruleSource('runHeader')})`)
  assert.match(runHeader(run), /^ответ не отдан · 15,1 с/)
  assert.equal(/готово/i.test(runHeader(run)), false)

  // Обычный удачный запуск ничего не теряет.
  const ok = {
    name: 'Спросил', status: 'running', warnings: 0, events: [],
    durationMs: null, startedAt: new Date().toISOString(),
  }
  addEvent(ok, {
    stage: 'done', title: 'Отдал ответ', status: 'succeeded', durationMs: 15100,
    data: { state: 'deliver', rounds: 1 },
  })
  assert.match(said[1], /готово за 15,1 с/)
  assert.match(runHeader(ok), /^готово · 15,1 с/)
  void announce, void fmtDuration, void shout, void renderMonitor, void trackRun
  void STATUS_WORD, void plural
})

test('признак «ответ не отдан» не залипает на следующем виде полосы', () => {
  // Подхват чужого запуска патча с ключом не несёт, и признак оставался:
  // «Выдача» идущего запуска с первой секунды несла крестик (находка reviewer
  // к PR #204). Умолчание гасит его, а завершение по-прежнему ставит.
  let runState = { view: 'done', withheld: true, index: 0 }
  const startPauseTimer = () => {}
  const stopPauseTimer = () => {}
  const renderRunbar = () => {}
  const setRunView = eval(`(${ruleSource('setRunView')})`)

  setRunView('running', { index: 1 })
  assert.equal(runState.withheld, false, 'подхват чужого запуска гасит признак')

  setRunView('done', { withheld: true })
  assert.equal(runState.withheld, true, 'завершение по-прежнему ставит признак')
  void startPauseTimer, void stopPauseTimer, void renderRunbar
})

test('при «годен» без вариантов фраза не договаривает «или 0 вариантов»', () => {
  // Ноль вариантов — штатный исход «годен»: предлагать нечего. Ветку привнесла
  // сама правка про объявления, и гейт облика снял её дословно дважды.
  const draftSaid = loadRule('draftSaid')

  assert.equal(
    draftSaid({ verdict: 'ok', variants: [] }, 1, false),
    'Формулировщик, ход 1 из 3. Формулировка годится — можно принять её.',
  )
  assert.equal(
    /0 вариант/.test(draftSaid({ verdict: 'ok', variants: [] }, 1, false)),
    false,
    'числа ноль в фразе быть не должно вовсе',
  )

  // «Годен» с вариантами фразу не теряет: их предлагают наравне с черновиком.
  assert.equal(
    draftSaid({ verdict: 'ok', variants: [{ text: 'а' }, { text: 'б' }] }, 2, false),
    'Формулировщик, ход 2 из 3. Формулировка годится, можно принять её или 2 варианта.',
  )
})

test('при «доработать» звучат замечание, число вариантов и предел ходов', () => {
  const draftSaid = loadRule('draftSaid')

  assert.equal(
    draftSaid({ verdict: 'revise', remark: 'слишком общо', variants: [{ text: 'а' }] }, 1, false),
    'Формулировщик, ход 1 из 3. Нужно доработать. слишком общо. 1 вариант на выбор.',
  )
  assert.equal(
    draftSaid({ verdict: 'revise', remark: '', variants: [{ text: 'а' }, { text: 'б' }, { text: 'в' }] }, 3, true),
    'Формулировщик, ход 3 из 3. Нужно доработать. 3 варианта на выбор.' +
      ' Ходов больше нет: примите вариант или отмените черновик.',
  )
  // Тупик по конфликту: вариантов нет, и об этом сказано прямо.
  assert.equal(
    draftSaid({ verdict: 'revise', remark: 'противоречит П2', variants: [] }, 1, false),
    'Формулировщик, ход 1 из 3. Нужно доработать. противоречит П2. Вариантов нет.',
  )
})
