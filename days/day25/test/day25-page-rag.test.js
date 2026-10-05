// Что страница дня 25 говорит о ходе: исход, цитаты, расход и состояние
// задачи (ADR 2026-10-05-0544, п. 2.3, 3.4 и 5).
//
// ПОЧЕМУ ДОСЛОВНОСТЬ ДЕРЖИТ ТЕСТ, А НЕ ДОКУМЕНТ РАСКЛАДКИ: отдельной фазы
// раскладки у дня 25 нет — решение владельца, ADR
// `2026-10-05-0942-day25-owner-amendments`. На п. 5 ADR `2026-10-05-0544`
// ссылаться нельзя: там требуется раскладка у дня 25, и это ровно то
// утверждение, которое владелец отменил. Экран взят от раскладки дня 15
// (`design/2026-09-21-1852-staged-run-layout.md`); дословные формулировки
// новых блоков держит ЭТОТ ТЕСТ — иначе их правка прошла бы незамеченной
// (урок п. 10 раскладки дня 22).
//
// Метод тот же, что в `day25-page-prompts.test.js`: правила вынесены в
// странице в выделяемый блок без DOM, тест ВЫРЕЗАЕТ ЭТОТ БЛОК ИЗ СТРАНИЦЫ и
// исполняет его — проверяется исходный текст страницы, а не копия в тесте.
// DOM-окружения в дне нет, поэтому живой браузер этим не заменяется.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const page = readFileSync(join(here, '..', 'public', 'index.html'), 'utf8')

const rules = (() => {
  const from = page.indexOf(
    '/* --- Выделяемый блок: его извлекает и исполняет test/day25-page-rag.test.js.',
  )
  assert.notEqual(from, -1, 'блок правил хода обязан остаться выделяемым')
  const to = page.indexOf('/* --- конец выделяемого блока --- */', from)
  assert.notEqual(to, -1, 'у блока правил хода обязан быть конец')
  return new Function(`${page.slice(from, to)}
    return { OUTCOME_TEXT, OUTCOME_UNKNOWN, WEAK_OUTCOMES, QUOTE_WORD, MONEY_TEXT,
             moneyWord, httpMoneyWord, outcomeText, weakOutcome, searchLine, orphanQuotes,
             claimedNote, checkLine, CLAIMED_PREFIX, CHECK_LABEL };`)()
})()

test('четыре исхода хода названы дословно и различимы между собой', () => {
  // Дословность: правка любой из четырёх строк краснит тест. Текстов именно
  // четыре — исход приходит полем сервиса, и пятого в контракте нет.
  assert.deepEqual(rules.OUTCOME_TEXT, {
    answered: 'Ответ по корпусу: ниже источники и дословные цитаты из них.',
    unsupported:
      'Ответ не подтверждён: ни одна цитата не нашлась в найденных фрагментах дословно.',
    unknown_filter:
      'Ответа в корпусе не нашлось: поиск нашёл фрагменты, но ни один из них не отнесён к реплике.',
    unknown_model: 'Ответа в найденных фрагментах нет — так сказала сама модель.',
  })
  // «Не знаю» отбора и «не знаю» модели — РАЗНЫЕ строки: в первом случае
  // ответа не нашёл поиск, во втором — модель по найденному. Один текст на
  // оба скрывал бы, кто именно не нашёл ответа (находка дня 22 о вердикте 0).
  assert.notEqual(rules.OUTCOME_TEXT.unknown_filter, rules.OUTCOME_TEXT.unknown_model)
  assert.equal(new Set(Object.values(rules.OUTCOME_TEXT)).size, 4)
})

test('исход, которого страница не знает, не выдаётся за благополучный', () => {
  assert.equal(rules.outcomeText('какой-то_новый'), rules.OUTCOME_UNKNOWN)
  assert.equal(rules.outcomeText(undefined), rules.OUTCOME_UNKNOWN)
  assert.match(rules.OUTCOME_UNKNOWN, /не узнала/)
  // И он не выглядит как «ответ по корпусу»: пометка тревоги у него остаётся.
  // Это и есть причина, по которой правило смотрит со стороны `answered`, а
  // не со стороны списка трёх слабых исходов: по списку неизвестный исход
  // попадал бы в спокойные (находка `reviewer` к PR #318 — прежняя редакция
  // этого теста утверждала обратное, и утверждение было ложным).
  assert.equal(rules.weakOutcome('answered'), false)
  assert.equal(rules.weakOutcome('какой-то_новый'), true, 'неизвестный исход выдан за спокойный')
  assert.equal(rules.weakOutcome(undefined), true)
  for (const outcome of rules.WEAK_OUTCOMES)
    assert.equal(rules.weakOutcome(outcome), true, `${outcome} выдан за ответ по корпусу`)
  assert.deepEqual(rules.WEAK_OUTCOMES, ['unsupported', 'unknown_filter', 'unknown_model'])
})

test('цитата помечена результатом сверки кода, а не старательностью модели', () => {
  assert.equal(rules.QUOTE_WORD.ok, 'проверена дословно')
  assert.equal(rules.QUOTE_WORD.bad, 'не найдена во фрагменте')
})

test('о деньгах молчим, когда сведений нет, и говорим, когда они есть', () => {
  // БЛОКИРУЮЩАЯ НАХОДКА `reviewer` к PR #318: строка о расходе печаталась под
  // каждым отказом, а признак `paidNothing` приходит только в `end` потока
  // событий. У отказа лимитера (429), у 4xx самого дня и у оборванного потока
  // признака нет, и страница говорила «слот считаем занятым» там, где слот не
  // занимали вовсе.
  //
  // Поэтому `null` — полноправный ответ правила: он означает «строки не
  // будет». Тест держит именно его: домысел в пользу бюджета пугал бы
  // посетителя расходом, которого не было, а домысел в его пользу обещал бы
  // возврат, которого не было.
  assert.equal(rules.moneyWord(true), 'free')
  assert.equal(rules.moneyWord(false), 'paid')
  assert.equal(rules.moneyWord(undefined), null, 'нет признака — обязано быть молчание')
  assert.equal(rules.moneyWord(null), null)
  // Код отказа на расход не влияет: отказ поиска денег не стоит, отказ
  // реранкера стоит, и вывести это из названия нельзя.
  assert.equal(rules.moneyWord('search_refused'), null)

  // Второе правило — про отказы САМОГО ДНЯ, и это не догадка: учёт слота у
  // дня идёт по коду ответа (`runLedger`), поэтому 4xx значит «не занят».
  assert.equal(rules.httpMoneyWord(429), 'none', 'отказ лимитера слота не занимал')
  assert.equal(rules.httpMoneyWord(400), 'none')
  assert.equal(rules.httpMoneyWord(409), 'none')
  assert.equal(rules.httpMoneyWord(502), 'unknown')
  assert.equal(rules.httpMoneyWord(503), 'unknown')
  assert.equal(rules.httpMoneyWord(202), null, 'успех о расходе не говорит')
  assert.equal(rules.httpMoneyWord(undefined), null)

  assert.deepEqual(rules.MONEY_TEXT, {
    free: 'Денег отказ не стоил: ни один вызов модели не состоялся, слот суточного лимита возвращён.',
    paid: 'Отказ оплачен: вызов модели состоялся, слот суточного лимита занят.',
    none: 'Денег отказ не стоил: до модели запрос не дошёл, слот суточного лимита не занят.',
    unknown: 'Был ли вызов модели оплачен, неизвестно: слот суточного лимита считаем занятым.',
  })
  // Четыре текста — четыре разных утверждения: «не занят» и «возвращён» это
  // разные вещи, и 429 не должен говорить про возврат.
  assert.equal(new Set(Object.values(rules.MONEY_TEXT)).size, 4)
})

test('каждый вызывающий говорит о деньгах ровно то, что знает', () => {
  // Проверка по исходнику страницы с номерами ветвей: правило верно только
  // если его ЗОВУТ в нужных местах и НЕ зовут в остальных.
  //
  // 1. поток событий — единственный источник `paidNothing`;
  assert.match(page, /const word = moneyWord\(end\.error\.paidNothing\);/)
  assert.match(page, /answered\(text, \{ error: true, money: word \}\);/)
  // 2. отказ дня по HTTP — из кода ответа, но слово самого дня сильнее: на
  //    отказе ДО резерва слота день ставит `slot: 'free'`, и «считаем занятым»
  //    было бы неправдой (находка `reviewer` к PR #318).
  assert.match(
    page,
    /money: data\.slot === 'free' \? 'none' : httpMoneyWord\(response\.status\),/,
  )
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8')
  assert.match(server, /return send\(res, 502, \{ error: AGENT_DOWN, slot: 'free' \}\)/)
  // И это ровно тот 502, который случается до `ctx.run.take`: ниже по тексту
  // обработчика, не выше.
  const atSlot = server.indexOf("slot: 'free'")
  const atTake = server.indexOf('const slot = ctx.run.take(rounds)')
  assert.ok(atSlot > 0 && atTake > atSlot, 'отказ со свободным слотом стоит уже после резерва')
  // 3. остальные три вызывающих молчат: ни `money`, ни `paidNothing`.
  const silent = [
    "answered('поток закрылся без ответа', { error: true });",
    "answered('связь с агентом прервана', { error: true });",
    "answered('запрос не отправлен', { error: true });",
  ]
  for (const call of silent) assert.ok(page.includes(call), `вызывающий изменился: ${call}`)
  // И ни один вызывающий не кладёт `paidNothing` в карточку напрямую: поле
  // карточки одно — `money`, уже разобранное слово.
  assert.equal(page.includes('paidNothing: end.error.paidNothing'), false)
  // Рендер не печатает строку без слова.
  assert.match(page, /const money = moneyLine\(meta\.money\);\n\s+if \(money\) li\.append\(money\);/)
})

test('слово о деньгах переживает перечитывание переписки, а не живёт один кадр', () => {
  // Находка `design-review` к PR #318: признак `paidNothing` приходит один
  // раз — в `end` потока, — а служба хранит реплику отказа как
  // `{ error: true, code }` без признака расхода. Карточка перерисовывается из
  // чтения переписки, и строка о деньгах исчезала через секунду после показа.
  //
  // Связь — по тексту отказа и только у ПОСЛЕДНЕЙ реплики: идентификатора
  // запуска у сохранённой реплики нет вовсе.
  assert.match(page, /let lastRefusal = null;/)
  assert.match(page, /lastRefusal = word === null \? null : \{ text, word \};/)
  assert.match(page, /fresh\.meta = \{ \.\.\.fresh\.meta, money: lastRefusal\.word \};/)
  // Правило переноса, выписанное из страницы: слово достаётся только свежей
  // реплике агента с тем же текстом и без своего слова.
  const carry = (refusal, fresh) =>
    refusal !== null &&
    fresh !== undefined &&
    fresh.role === 'agent' &&
    fresh.meta?.error === true &&
    fresh.meta.money === undefined &&
    fresh.text === refusal.text
  const refusal = { text: 'Поиск отказал. Модель не вызывалась.', word: 'free' }
  const stored = { role: 'agent', text: refusal.text, meta: { error: true, code: 'search_refused' } }
  assert.equal(carry(refusal, stored), true)
  // Чужой текст — не переносим: это другой отказ.
  assert.equal(carry(refusal, { ...stored, text: 'другое' }), false)
  // Не отказ и не реплика агента — тоже нет.
  assert.equal(carry(refusal, { ...stored, meta: {} }), false)
  assert.equal(carry(refusal, { ...stored, role: 'user' }), false)
  // Своё слово не перебиваем.
  assert.equal(carry(refusal, { ...stored, meta: { error: true, money: 'paid' } }), false)
  // Нет памяти — нет переноса.
  assert.equal(carry(null, stored), false)
  // Память уходит вместе с диалогом: чужое слово не достаётся новой переписке.
  assert.match(page, /taskUnstored = false;\n\s+lastRefusal = null;/)
})

test('строка поиска называет переписанный запрос, а молчание — словами', () => {
  const line = rules.searchLine({
    rewritten: 'инвариант I-4 порядок лимитер до вызова',
    sources: [{ n: 1 }, { n: 4 }],
    index: { commit: '4de2d6e' },
  })
  assert.match(line, /поиск по переписанному запросу: «инвариант I-4 порядок лимитер до вызова»/)
  assert.match(line, /фрагментов модели: 2/)
  assert.match(line, /индекс 4de2d6e/)
  // Переписывание у дня 25 идёт всегда, но нового запроса могло не дать:
  // пустое место здесь читалось бы как «поиска не было».
  const plain = rules.searchLine({ rewritten: null, sources: [], index: {} })
  assert.match(plain, /поиск только по реплике: переписывание не дало нового запроса/)
  assert.match(plain, /фрагментов модели: 0/)
})

test('цитата с номером, которого нет среди источников, не теряется', () => {
  // Модель вправе сослаться не на всё, что процитировала. Выброшенная цитата
  // означала бы, что экран показывает ответ лучше, чем он есть.
  const quotes = [{ n: 1, text: 'а', verified: true }, { n: 7, text: 'б', verified: false }]
  const cited = [{ n: 1, source: 'AGENTS.md', section: 'Роли' }]
  assert.deepEqual(rules.orphanQuotes(quotes, cited), [quotes[1]])
  assert.deepEqual(rules.orphanQuotes(quotes, []), quotes)
  assert.deepEqual(rules.orphanQuotes([], cited), [])
})

// --- панель состояния задачи ------------------------------------------------

test('панель состояния задачи переживает перезагрузку и читает его у службы', () => {
  // Было честное «после перезагрузки панель пуста»: служба состояния в
  // переписке не отдавала. PR #317 завёл поле `task` в чтении диалога по этой
  // самой находке, и теперь текст обязан говорить правду, а не прежнюю
  // границу.
  const empty = page.match(/const TASK_EMPTY =\n([\s\S]*?);\n/)
  assert.notEqual(empty, null, 'текст пустой панели обязан остаться в одном месте')
  assert.match(empty[1], /переживёт перезагрузку страницы/)
  assert.equal(/не отдаёт/.test(empty[1]), false, 'в тексте осталась снятая граница')
  // И состояние действительно берётся из чтения переписки, а не только из
  // результата хода: иначе обещание «переживёт перезагрузку» было бы ложью.
  assert.match(page, /\n    taskState = d\.task \?\? null;/)
  // Ветви «а если поля нет вовсе» быть не должно: ручка ставит `task` во всех
  // ответах, и прежняя такая ветвь была мёртвой (находка `reviewer`).
  assert.equal(page.includes('born'), false, 'мёртвая ветвь первого хода вернулась')
  // Сервер проносит поле от службы и не достраивает его сам.
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8')
  assert.match(server, /task: json\.task \?\? null,/)
  // У пустых ветвей переписки состояния нет — панель не покажет чужое.
  assert.equal((server.match(/task: null,/g) ?? []).length, 3, 'пустых ветвей переписки три')
})

test('состояние задачи показывается то, что лежит у службы', () => {
  // Панель не достраивает состояние: пришло — показывает, `null` — пусто.
  // Второго источника истины здесь быть не должно: в поиск следующего хода
  // уйдёт именно то, что лежит у службы.
  const adopt = (task) => task ?? null
  assert.deepEqual(adopt({ goal: 'из службы' }), { goal: 'из службы' })
  assert.equal(adopt(null), null)
  assert.equal(adopt(undefined), null)

  // Предупреждение «не сохранено» живёт отдельно от состояния: в панели стоит
  // то, что у службы, а предупреждение — про неудавшуюся правку.
  assert.match(page, /taskUnstored = r\.task\.stored === false;/)
  assert.match(page, /warn\.hidden = !taskUnstored;/)
  // И оно не переезжает в другой диалог вместе с состоянием.
  assert.match(page, /taskUnstored = false;\n\s+lastRefusal = null;/)
})

test('недоверенный текст хода попадает на экран только через textContent', () => {
  // Пути, разделы, цитаты, уточняющий вопрос и цель задачи приходят из
  // корпуса и от модели. Единственная проверка, которую можно сделать по
  // исходнику: ни одного innerHTML/insertAdjacentHTML на всю страницу.
  assert.equal(page.includes('innerHTML'), false, 'на странице появился innerHTML')
  assert.equal(page.includes('insertAdjacentHTML'), false)
  assert.equal(page.includes('outerHTML'), false)
  // И точечно — у узлов карточки хода: текст ставится присваиванием
  // textContent или append со строкой, а не разметкой.
  assert.match(page, /text\.textContent = String\(quote\.text \?\? ''\);/)
  assert.match(page, /goal\.textContent = taskState\.goal \? taskState\.goal : 'пока не названа';/)
})

test('отказанный ход не выдаётся полосой за «Готово»', () => {
  // У дня 25 это главный путь отказа: поиск обрывает ход до вызова модели.
  // Полоса дня 15 ставила галочки всем этапам и писала «Готово» — то есть
  // утверждала, что «Поиск» прошёл.
  assert.match(
    page,
    /case 'failed':\n\s+return `Ход отказан · остановился на этапе \$\{runState\.index \|\| 1\} из \$\{total\}`;/,
  )
  // И вид действительно выбирается по статусу запуска, а не остаётся «done».
  assert.match(page, /} else if \(end\.status === 'failed'\) \{/)
  assert.match(page, /finish\('failed'\);/)
  // Строка статуса при этом помечена как предупреждение, а не нейтральна:
  // цвет не единственный носитель смысла, но и он обязан совпадать со словами.
  assert.match(page, /view === 'cancelled' \|\| view === 'lost' \|\| view === 'failed',/)
})

// --- путь источника и четвёртая проверка (находка `compliance` к PR #318) ---

test('что назвала модель, страница читает из claimedSource, а не из source', () => {
  // БЛОКИРУЮЩАЯ НАХОДКА `compliance` к PR #318. По контракту хода
  // (`agent_docs/guides/day25-chat-contract.md`, «Результат хода») у записи
  // `cited[]` путь и раздел УЖЕ из отбора, а заявленное моделью лежит рядом в
  // `claimedSource`/`claimedSection` (`agents/src/rag/cited.js`). Прежняя
  // редакция страницы читала `cited[].source` как заявленное и сравнивала его
  // с отбором сама: поля совпадали по построению, поэтому «модель назвала»
  // не показывалось НИКОГДА.
  assert.equal(rules.CLAIMED_PREFIX, 'модель назвала: ')
  // Совпало — строки нет: пометка под каждым источником обесценила бы её.
  assert.equal(
    rules.claimedNote({ n: 1, source: 'agent_docs/invariants.md', claimedSource: 'agent_docs/invariants.md' }),
    null,
  )
  // Разошлось — названо имя, а не только признак.
  assert.equal(
    rules.claimedNote({ n: 1, source: 'agent_docs/invariants.md', claimedSource: 'AGENTS.md' }),
    'модель назвала: AGENTS.md',
  )
  // Пустое и отсутствующее заявленное — молчание: сравнивать не с чем.
  assert.equal(rules.claimedNote({ n: 1, source: 'AGENTS.md', claimedSource: '' }), null)
  assert.equal(rules.claimedNote({ n: 1, source: 'AGENTS.md' }), null)
  assert.equal(rules.claimedNote(undefined), null)
  // Мутация, на которой тест краснеет: вернуть чтение `cited.source` вместо
  // `cited.claimedSource` — тогда расхождение снова не покажется никогда.
  assert.match(page, /const claimed = cited\?\.claimedSource;/)
  // И путь в строке источника берётся как есть: он уже из отбора, второй
  // сверки страница не делает.
  assert.match(page, /head\.append\(n, ' ', String\(src\.source \?\? ''\)\);/)
})

test('четвёртая проверка — поле службы, а не счёт страницы', () => {
  // `checks.cited_exact` считает служба точным сравнением (не по подстроке —
  // находка дня 22 про q72/q57). Второй счёт на странице разошёлся бы с
  // первым молча, поэтому его нет вовсе.
  assert.deepEqual(Object.keys(rules.CHECK_LABEL), [
    'sources_present', 'quotes_present', 'quotes_verbatim', 'cited_exact',
  ])
  assert.equal(rules.CHECK_LABEL.cited_exact, 'путь источника назван моделью точно')
  assert.equal(
    /сверка страницы/.test(rules.CHECK_LABEL.cited_exact),
    false,
    'ярлык всё ещё обещает счёт страницы',
  )
  // Все четыре клетки читаются из `checks` одной формулой.
  const line = rules.checkLine({
    sources_present: true,
    quotes_present: true,
    quotes_verbatim: false,
    cited_exact: false,
  })
  assert.match(line, /источники названы — да/)
  assert.match(line, /цитаты приведены — да/)
  assert.match(line, /цитаты найдены дословно — нет/)
  assert.match(line, /путь источника назван моделью точно — нет/)
  // Непришедшая проверка — «не пришло», а не «нет» (I-8): страница не
  // называет непришедшее проваленным.
  const partial = rules.checkLine({ sources_present: true })
  assert.match(partial, /цитаты приведены — не пришло/)
  assert.match(partial, /путь источника назван моделью точно — не пришло/)
  assert.match(rules.checkLine(undefined), /источники названы — не пришло/)
  // Страница зовёт правило ровно с полем службы и ничем больше.
  assert.match(page, /checkLine\(rag\.checks\)/)
})
