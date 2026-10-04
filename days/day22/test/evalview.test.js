// Правила секции итогов — исполнением (days/day22/public/evalview.js).
//
// Предмет здесь — утверждение «страница не утверждает больше, чем считает».
// Поэтому проверяются все три случая вывода, включая третий («числа
// расходятся»), и то, что числа приходят из данных, а не из разметки.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  GENERAL_NOTE,
  limitsText,
  mechanics,
  NOT_RUN,
  parseEval,
  partialNote,
  tally,
  verdict,
  verdictWord,
} from '../public/evalview.js'

/** Один вопрос эталона в форме файла прогона (ADR 2026-10-04-0735, пп. 5–6). */
const q = (id, set, rag, norag, over = {}) => ({
  id,
  set,
  question: `вопрос ${id}`,
  expect: 'верный ответ',
  key: 'ключевая фраза',
  sources: set === 'general' ? [] : ['agent_docs/guides/dod.md'],
  modes: { ...(rag ? { rag } : {}), ...(norag ? { norag } : {}) },
  ...over,
})
const mode = (verdictValue, over = {}) => ({
  answer: 'текст ответа',
  retrieved: true,
  cited: true,
  key: true,
  refused: false,
  verdict: verdictValue,
  ...over,
})
const refusal = () => mode(null, { refused: true, cited: false, key: false })

const file = (questions, over = {}) => ({
  ranAt: '2026-10-04T12:00:00Z',
  index: { commit: '57a5cd7', strategy: 'structural' },
  judge: { name: 'экземпляр роли reviewer', rubric: '0 — неверно; 1 — частично; 2 — верно и по источнику' },
  questions,
  ...over,
})

/** Набор дня: 6 «попавших», 2 «промахнувшихся», 2 общих (ADR, п. 5). */
function set10({ ragWrong = 0, noragCorrect = 1 } = {}) {
  const items = []
  for (let i = 0; i < 6; i += 1)
    items.push(q(`q0${i}`, 'first', mode(2), mode(i < noragCorrect ? 2 : 1)))
  items.push(q('q72', 'missed', refusal(), mode(0)))
  items.push(q('q94', 'missed', refusal(), mode(0)))
  items.push(q('m01', 'general', mode(ragWrong > 0 ? 0 : 2), mode(2)))
  items.push(q('m02', 'general', mode(ragWrong > 1 ? 0 : 1), mode(0)))
  return items
}

test('разбор файла: отсутствующий режим — null, а не выдуманные нули', () => {
  const parsed = parseEval(file([q('q08', 'first', mode(2), null)]))
  assert.equal(parsed.questions[0].norag, null)
  assert.equal(verdictWord(parsed.questions[0].norag), NOT_RUN)
})

test('разбор файла не падает на чужом вводе и не выдумывает судью', () => {
  for (const bad of [null, 'строка', 42, [], {}, { questions: 'нет', judge: 'нет' }]) {
    const parsed = parseEval(bad)
    assert.deepEqual(parsed.questions, [])
    assert.equal(parsed.judge.name, null)
    assert.equal(parsed.judge.rubric, null)
  }
  // Вердикт чужой формы в рубрику не пролезает.
  const odd = parseEval(file([q('q1', 'first', mode('два'), mode(5))]))
  assert.equal(odd.questions[0].rag.verdict, null)
  assert.equal(odd.questions[0].norag.verdict, null)
})

test('отказ занимает МЕСТО вердикта: суммы строк сходятся к числу вопросов', () => {
  const t = tally(parseEval(file(set10())))
  assert.equal(t.compared, 10)
  for (const name of ['rag', 'norag']) {
    const c = t.counts[name]
    assert.equal(c.correct + c.partial + c.wrong + c.refused, 10, name)
  }
  assert.deepEqual(t.counts.rag, { correct: 7, partial: 1, wrong: 0, refused: 2 })
})

test('сводка считается только по вопросам, где прогнаны ОБА режима', () => {
  const items = [...set10(), q('q99', 'first', mode(2), null)]
  const t = tally(parseEval(file(items)))
  assert.equal(t.total, 11)
  assert.equal(t.compared, 10)
  assert.equal(partialNote(t), 'Сравнение считается по 10 вопросам из 11: у остальных прогнан один режим.')
})

test('при неполном прогоне вывода нет вовсе: десяти вопросов ещё не было', () => {
  const t = tally(parseEval(file([...set10(), q('q99', 'first', mode(2), null)])))
  assert.equal(verdict(t), null)
  assert.equal(verdict(tally(parseEval(file([])))), null)
})

test('случай 1: один режим вернее — числа в фразе те же, что в сводке', () => {
  const t = tally(parseEval(file(set10())))
  const v = verdict(t)
  assert.equal(v.kind, 'better')
  assert.match(v.lead, /режим с RAG вернее/)
  assert.match(v.text, /7 ответов верны и подтверждены источником против 2/)
  assert.match(v.text, /выдуманных — 0 против 3/)
})

test('случай 2: разница в пределах порога шума — вывода о лучшем режиме нет', () => {
  // Пять «попавших» вопросов верны обоим режимам: разница верных — один
  // вопрос, то есть внутри порога шума.
  const t = tally(parseEval(file(set10({ noragCorrect: 5 }))))
  assert.equal(t.counts.rag.correct - t.counts.norag.correct, 1)
  const v = verdict(t)
  assert.equal(v.kind, 'same')
  assert.match(v.lead, /не различились/)
  assert.match(v.text, /не больше 2 вопросов из 10/)
})

test('случай 3 ДОСТИЖИМ: верных больше у режима, у которого больше и выдуманных', () => {
  // У «с RAG» шесть верных против трёх, но и выдуманных у него больше.
  const items = []
  for (let i = 0; i < 6; i += 1) items.push(q(`q0${i}`, 'first', mode(2), mode(i < 3 ? 2 : 1)))
  items.push(q('q72', 'missed', mode(0), mode(1)))
  items.push(q('q94', 'missed', mode(0), mode(1)))
  items.push(q('m01', 'general', mode(0), mode(1)))
  items.push(q('m02', 'general', mode(1), mode(1)))
  const t = tally(parseEval(file(items)))
  assert.equal(t.counts.rag.correct > t.counts.norag.correct, true)
  assert.equal(t.counts.rag.wrong > t.counts.norag.wrong, true)
  const v = verdict(t)
  assert.equal(v.kind, 'split')
  assert.match(v.lead, /Числа расходятся/)
  assert.match(v.text, /Одного вывода эти 10 вопросов не дают/)
})

test('третий случай не подменяется выбором по одной колонке', () => {
  // Та же разница верных, но выдуманных у вернейшего режима МЕНЬШЕ — тогда
  // вывод о лучшем режиме законен. Отличие ровно в одной колонке, и вердикт
  // меняется: значит, он считает её, а не игнорирует.
  const items = []
  for (let i = 0; i < 6; i += 1) items.push(q(`q0${i}`, 'first', mode(2), mode(i < 3 ? 2 : 1)))
  items.push(q('q72', 'missed', mode(1), mode(0)))
  items.push(q('q94', 'missed', mode(1), mode(0)))
  items.push(q('m01', 'general', mode(1), mode(0)))
  items.push(q('m02', 'general', mode(1), mode(1)))
  const v = verdict(tally(parseEval(file(items))))
  assert.equal(v.kind, 'better')
})

test('состав набора в границах метода приходит из данных, а не из текста', () => {
  const ten = limitsText(parseEval(file(set10())))
  assert.match(ten, /Вопросов 10/)
  assert.match(ten, /6 вопросов, где поиск находил верный документ первым/)
  assert.match(ten, /2, где он промахивался в обеих стратегиях/)
  assert.match(ten, /2 общих — без источника в проекте вовсе/)

  // Изменился состав — изменился текст. Это и есть держатель критерия 10.
  const other = limitsText(parseEval(file([q('a', 'first', mode(2), mode(2)), q('b', 'general', mode(2), mode(2))])))
  assert.match(other, /Вопросов 2/)
  assert.match(other, /1 вопрос, где поиск находил верный документ первым/)
  assert.match(other, /1 общий — без источника/)
})

test('вопрос без пометки состава не прячется в одну из трёх групп', () => {
  const text = limitsText(parseEval(file([q('a', 'first', mode(2), mode(2)), { id: 'b', question: 'без пометки' }])))
  assert.match(text, /Вопросов 2/)
  assert.match(text, /Ещё 1 вопрос состав не называет/)
})

test('границы метода называют одну пробу и то, что судья — тоже модель', () => {
  const text = limitsText(parseEval(file(set10())))
  assert.match(text, /статистики здесь нет/)
  assert.match(text, /один образец ответа/)
  assert.match(text, /ловит форму, а не смысл/)
  assert.match(text, /Судья — тоже модель/)
})

test('вердикт строки — слово; отказ и «не прогнан» — свои случаи, не вердикты', () => {
  assert.equal(verdictWord(mode(2)), 'верно')
  assert.equal(verdictWord(mode(1)), 'частично')
  assert.equal(verdictWord(mode(0)), 'неверно')
  assert.equal(verdictWord(refusal()), 'отказ')
  assert.equal(verdictWord(mode(null)), NOT_RUN)
  assert.equal(verdictWord(null), NOT_RUN)
})

test('механика — слова «да/нет»; у режима без RAG строка о найденном не выдумывается', () => {
  assert.deepEqual(mechanics(mode(2), { rag: true }), [
    'источник найден: да',
    'источник назван: да',
    'ключевая фраза: да',
  ])
  assert.deepEqual(mechanics(mode(1, { cited: false, key: false }), { rag: false }), [
    'поиска не было',
    'источник назван: нет',
    'ключевая фраза: нет',
  ])
  // Не измерено — строки нет вовсе: «нет» на месте неизмеренного было бы
  // утверждением о проверке, которой не делали (I-8).
  assert.deepEqual(mechanics(mode(2, { retrieved: null, cited: null, key: null }), { rag: true }), [])
  assert.deepEqual(mechanics(null, { rag: true }), [])
})

test('у общего вопроса верного источника нет, и так и сказано', () => {
  const parsed = parseEval(file(set10()))
  const general = parsed.questions.find((item) => item.id === 'm01')
  assert.deepEqual(general.sources, [], 'общий вопрос без источника')
  assert.match(GENERAL_NOTE, /строгий промпт обязан отказать/)
})
