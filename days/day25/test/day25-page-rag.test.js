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
             moneyWord, outcomeText, weakOutcome, searchLine, orphanQuotes };`)()
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
  assert.equal(rules.weakOutcome('answered'), false)
  for (const outcome of ['unsupported', 'unknown_filter', 'unknown_model'])
    assert.equal(rules.weakOutcome(outcome), true, `${outcome} выдан за ответ по корпусу`)
})

test('цитата помечена результатом сверки кода, а не старательностью модели', () => {
  assert.equal(rules.QUOTE_WORD.ok, 'проверена дословно')
  assert.equal(rules.QUOTE_WORD.bad, 'не найдена во фрагменте')
})

test('о деньгах сказано ровно то, что сказал сервис признаком paidNothing', () => {
  // Три случая, и третий — главный: признака нет. Домыслить «не оплачено»
  // здесь значило бы обещать посетителю возврат, которого не было.
  assert.equal(rules.moneyWord(true), 'free')
  assert.equal(rules.moneyWord(false), 'paid')
  assert.equal(rules.moneyWord(undefined), 'unknown')
  assert.equal(rules.moneyWord(null), 'unknown')
  // Код отказа на расход не влияет: отказ поиска денег не стоит, отказ
  // реранкера стоит, и вывести это из названия нельзя.
  assert.equal(rules.moneyWord('search_refused'), 'unknown')
  assert.deepEqual(rules.MONEY_TEXT, {
    free: 'Денег отказ не стоил: ни один вызов модели не состоялся, слот суточного лимита возвращён.',
    paid: 'Отказ оплачен: вызов модели состоялся, слот суточного лимита занят.',
    unknown:
      'Был ли вызов модели оплачен, сервис не сказал — слот суточного лимита считаем занятым.',
  })
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
