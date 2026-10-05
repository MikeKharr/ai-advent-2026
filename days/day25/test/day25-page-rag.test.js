// Что страница дня 25 говорит о ходе: исход, цитаты, расход и состояние
// задачи (ADR 2026-10-05-0544, п. 2.3, 3.4 и 5).
//
// Раскладки у дня нет сверх раскладки дня 15 (решение владельца о процессе),
// поэтому дословные формулировки держит ЭТОТ ТЕСТ: иначе их правка прошла бы
// незамеченной — тот же урок, что в дне 22 (п. 10 его раскладки).
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
             fragmentOf, claimedNote, citedExact, checkLine, CLAIMED_PREFIX, CHECK_LABEL };`)()
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
  assert.match(page, /money: moneyWord\(end\.error\.paidNothing\),/)
  // 2. отказ дня по HTTP — из кода ответа;
  assert.match(page, /money: httpMoneyWord\(response\.status\),/)
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

test('панель состояния задачи честна о том, чего после перезагрузки нет', () => {
  // Служба состояние в переписке не отдаёт, и восстанавливать его по репликам
  // страница не вправе: это была бы придуманная цель. Панель обязана сказать
  // это словами, а не остаться пустой.
  const empty = page.match(/const TASK_EMPTY =\n([\s\S]*?);\n/)
  assert.notEqual(empty, null, 'текст пустой панели обязан остаться в одном месте')
  assert.match(empty[1], /в переписке служба состояние/)
  assert.match(empty[1], /не отдаёт/)
  assert.match(empty[1], /после следующего ответа/)
})

test('состояние задачи уходит вместе с диалогом, но не на первом его ходе', () => {
  // Правило из страницы: смена диалога и его отсутствие сбрасывают состояние,
  // а появление имени у диалога, который только что родился первым ходом, —
  // нет. Без второго условия панель гасла бы сразу после первого ответа.
  const guard = page.match(
    /if \(nextSession === null \|\| \(sessionName !== null && nextSession !== sessionName\)\)\n\s+taskState = null;/,
  )
  assert.notEqual(guard, null, 'правило срока состояния задачи переписано — проверьте оба условия')
  const drop = (sessionName, nextSession) =>
    nextSession === null || (sessionName !== null && nextSession !== sessionName)
  assert.equal(drop(null, 'синий-кит-7'), false, 'первый ход нового диалога гасил бы панель')
  assert.equal(drop('синий-кит-7', 'синий-кит-7'), false)
  assert.equal(drop('синий-кит-7', 'тихий-лис-3'), true, 'чужая цель осталась бы на экране')
  assert.equal(drop('синий-кит-7', null), true, '«очистить» не унесло состояние с экрана')
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

test('путь источника берётся из отбора, а не из ответа модели', () => {
  // Под подтверждённой дословно цитатой иначе стоял бы путь, который модель
  // придумала: номер её, путь наш (образец — день 24).
  const sources = [
    { n: 1, source: 'agent_docs/invariants.md', section: 'I-4' },
    { n: 4, source: 'days/day25/server.js', section: 'диспетчер' },
  ]
  assert.equal(rules.fragmentOf(1, sources).source, 'agent_docs/invariants.md')
  assert.equal(rules.fragmentOf(9, sources), null, 'чужой номер пути не получает')
  assert.equal(rules.fragmentOf(1, undefined), null)
  // И рендер строки источника действительно зовёт отбор, а не поле ответа.
  assert.match(page, /const real = fragmentOf\(src\.n, sources\);/)
  assert.match(page, /head\.append\(n, ' ', String\(real\?\.source \?\? src\.source \?\? ''\)\);/)
})

test('расхождение пути не прячется: «модель назвала» стоит рядом', () => {
  const sources = [{ n: 1, source: 'agent_docs/invariants.md', section: 'I-4' }]
  assert.equal(rules.CLAIMED_PREFIX, 'модель назвала: ')
  // Совпало — строки нет: лишняя пометка под каждым источником обесценила бы её.
  assert.equal(rules.claimedNote({ n: 1, source: 'agent_docs/invariants.md' }, sources), null)
  // Разошлось — названо имя, а не только признак.
  assert.equal(
    rules.claimedNote({ n: 1, source: 'AGENTS.md' }, sources),
    'модель назвала: AGENTS.md',
  )
  // Нет поля, пустая строка и неизвестный номер — тоже молчание: сравнивать
  // не с чем, а выдуманный путь показывать нечего.
  assert.equal(rules.claimedNote({ n: 1, source: '' }, sources), null)
  assert.equal(rules.claimedNote({ n: 1 }, sources), null)
  assert.equal(rules.claimedNote({ n: 7, source: 'AGENTS.md' }, sources), null)
})

test('четвёртая проверка считается точным сравнением и помечена как сверка страницы', () => {
  const sources = [
    { n: 1, source: 'agent_docs/invariants.md', section: 'I-4' },
    { n: 4, source: 'days/day25/server.js', section: 'диспетчер' },
  ]
  const exact = [
    { n: 1, source: 'agent_docs/invariants.md' },
    { n: 4, source: 'days/day25/server.js' },
  ]
  assert.equal(rules.citedExact(exact, sources), true)
  // Точное сравнение, а не по подстроке — находка дня 22 про q72/q57.
  assert.equal(
    rules.citedExact([{ n: 1, source: 'invariants.md' }], sources),
    false,
    'подстрока прошла за точное совпадение',
  )
  assert.equal(rules.citedExact([{ n: 1, source: 'agent_docs/invariants.md' }, { n: 4, source: 'нет' }], sources), false)
  // Ни одного названного источника — считать не по чему, и это не «нет».
  assert.equal(rules.citedExact([], sources), null)
  assert.equal(rules.citedExact(undefined, sources), null)

  // Поля `cited_exact` в контракте дня 25 нет: три проверки от службы,
  // четвёртая — сверка страницы, и в ярлыке это сказано.
  assert.match(rules.CHECK_LABEL.cited_exact, /сверка страницы/)
  assert.deepEqual(Object.keys(rules.CHECK_LABEL), [
    'sources_present', 'quotes_present', 'quotes_verbatim', 'cited_exact',
  ])

  // Непришедшая проверка — «не пришло», а не «нет» (I-8).
  const line = rules.checkLine({ sources_present: true, quotes_present: true }, exact, sources)
  assert.match(line, /источники названы — да/)
  assert.match(line, /цитаты найдены дословно — не пришло/)
  assert.match(line, /путь источника назван моделью точно \(сверка страницы\) — да/)
  const bad = rules.checkLine(
    { sources_present: true, quotes_present: true, quotes_verbatim: false },
    [{ n: 1, source: 'AGENTS.md' }],
    sources,
  )
  assert.match(bad, /цитаты найдены дословно — нет/)
  assert.match(bad, /точно \(сверка страницы\) — нет/)
})
