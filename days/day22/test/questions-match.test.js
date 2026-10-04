// Набор вопросов дня 22 против эталона rag/eval/queries.json (ADR
// 2026-10-04-0735, п. 5).
//
// ЗАЧЕМ ЭТОТ ТЕСТ ВООБЩЕ. Весь смысл брать вопросы из эталона — в том, что у
// них ТАМ есть выверенный ответ, цитата и источник под тестом
// rag/test/test_eval.py::ЭталонныеОтветы. Разъедутся копии — и `expect` на
// странице дня перестанет быть выверенным ответом, оставшись похожим на него
// текстом. Поэтому проверяется равенство, а не похожесть.
//
// Образец чтения соседнего каталога — days/day20/test/style-copy.test.js.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const read = (...parts) => JSON.parse(readFileSync(join(here, ...parts), 'utf8'))

const mine = read('..', 'eval', 'questions.json')
const reference = read('..', '..', '..', 'rag', 'eval', 'queries.json')

/** Состав набора — ADR, п. 5, и из него страница берёт текст границ метода. */
const COMPOSITION = { first: 6, missed: 2, general: 2 }
const TOTAL = 10

test('эталон прочитан и не пуст — иначе проверка ничего не проверит', () => {
  // Пустой или переехавший эталон обнулил бы все проверки ниже молча: цикл по
  // нулю записей зелёный. Поэтому сначала утверждается, что сверять есть с чем.
  assert.ok(Array.isArray(reference.queries), 'queries эталона — массив')
  assert.ok(reference.queries.length >= 100, `записей эталона ${reference.queries.length}`)
})

test('вопросов ровно десять, и состав набора тот, что назван в ADR', () => {
  assert.equal(mine.questions.length, TOTAL)
  const counted = {}
  for (const q of mine.questions) counted[q.set] = (counted[q.set] ?? 0) + 1
  assert.deepEqual(counted, COMPOSITION)
})

test('идентификаторы уникальны', () => {
  const ids = mine.questions.map((q) => q.id)
  assert.equal(new Set(ids).size, ids.length, `повтор среди ${ids.join(', ')}`)
})

test('каждое поле взятых из эталона равно записи эталона', () => {
  const fromReference = mine.questions.filter((q) => q.origin !== null)
  // Число названо, а не выведено из файла: подмена origin на null у всех
  // записей оставила бы цикл пустым и зелёным.
  assert.equal(fromReference.length, COMPOSITION.first + COMPOSITION.missed)
  for (const q of fromReference) {
    const src = reference.queries.find((x) => x.id === q.origin)
    assert.ok(src, `в эталоне нет записи ${q.origin} — ссылка набора висит в пустоту`)
    assert.equal(q.question, src.question, `${q.id}: вопрос разошёлся с эталоном`)
    assert.equal(q.expect, src.answer, `${q.id}: верный ответ разошёлся с эталоном`)
    assert.deepEqual(q.sources, src.expected, `${q.id}: источники разошлись с эталоном`)
  }
})

test('у общих вопросов нет ни источника, ни ключевой фразы', () => {
  const general = mine.questions.filter((q) => q.set === 'general')
  assert.equal(general.length, COMPOSITION.general)
  for (const q of general) {
    assert.equal(q.origin, null, `${q.id}: общий вопрос не из эталона`)
    assert.deepEqual(q.sources, [], `${q.id}: верного источника у общего вопроса не бывает`)
    assert.equal(q.key, null, `${q.id}: ключевой фразы у общего вопроса нет`)
    assert.ok(q.expect.length > 0, `${q.id}: верный ответ всё равно нужен — его сверяет судья`)
  }
})

test('у взятых из эталона ключевая фраза есть и она не пуста', () => {
  for (const q of mine.questions.filter((x) => x.origin !== null)) {
    assert.equal(typeof q.key, 'string', `${q.id}: ключевая фраза обязана быть строкой`)
    assert.ok(q.key.trim().length > 0, `${q.id}: ключевая фраза пуста`)
  }
})

test('ключевая фраза взята из эталона, а не выдумана рядом с ним', () => {
  // Что это держит: фразу, которой в эталонной записи нет вовсе. Такая фраза
  // дала бы `key: false` на любом ответе модели, и колонка механики врала бы
  // всем вопросом сразу. Смысла фразы это не проверяет — только её
  // происхождение.
  //
  // Искать разрешено в трёх местах записи, и это НЕ послабление ради зелёного:
  // у q94 выверенный ответ пишет число словом («Пятьсот раз в сутки»), а
  // машинное `500` стоит в `phrase` и в дословной цитате — ровно в той форме,
  // которую назовёт модель. Поиск только по `answer` забраковал бы верную
  // фразу (замер: первая редакция набора на этом и покраснела).
  const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  for (const q of mine.questions.filter((x) => x.key !== null)) {
    const src = reference.queries.find((x) => x.id === q.origin)
    const grounds = [q.expect, src.phrase, src.evidence].map(flat)
    assert.ok(
      grounds.some((text) => text.includes(flat(q.key))),
      `${q.id}: ключевой фразы «${q.key}» нет ни в ответе, ни в phrase, ни в цитате эталона`,
    )
  }
})
