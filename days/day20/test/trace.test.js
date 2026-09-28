// Правила записи вызова — ИСПОЛНЕНИЕМ: импортируется тот самый модуль, который
// исполняет браузер. Функция с DOM (renderCall) здесь не вызывается и не
// проверяется — её предмет визуальный, и его смотрит /design-review.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  NO_METHOD,
  NO_PICKS,
  NO_ROUND,
  NO_SERVER,
  NO_WORDS,
  callMeta,
  callTitle,
  compareHashes,
  parseCall,
  parseWords,
  picksLine,
  sha256Of,
  stopNote,
  toolName,
  wordsText,
  wordsTitle,
} from '../public/trace.js'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

const event = (over = {}) => ({
  server: 'mcpstore',
  method: 'tools/call',
  request: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'file.read', arguments: {} } },
  response: { jsonrpc: '2.0', id: 1, result: { sha256: HASH_A } },
  status: 200,
  ms: 412,
  clipped: false,
  ...over,
})

test('имя сервера стоит у каждого вызова — это сквозное требование дней 18–20', () => {
  assert.ok(callTitle(parseCall(event())).startsWith('mcpstore · '))
})

test('имени сервера нет — на его месте слово, а не пустота и не выдуманное имя', () => {
  const call = parseCall(event({ server: undefined }))
  assert.equal(call.server, null)
  const title = callTitle(call)
  // Сравнение с самой константой гипотез не различает: при NO_SERVER = ''
  // оно зелёное, а в заголовке на месте имени пустота. Пустоту ловит эта строка.
  assert.match(title, /^\S/, `на месте имени сервера пустота: ${JSON.stringify(title)}`)
  assert.ok(title.startsWith(`${NO_SERVER} · `))
})

test('пустая строка именем сервера не считается', () => {
  assert.equal(parseCall(event({ server: '' })).server, null)
})

test('метода нет — тоже слово', () => {
  assert.ok(callTitle(parseCall(event({ method: undefined }))).includes(NO_METHOD))
})

test('у tools/call в заголовок попадает имя инструмента из тела запроса', () => {
  assert.equal(callTitle(parseCall(event())), 'mcpstore · tools/call file.read')
})

test('имя инструмента берётся из запроса, а не из ответа и не из порядка шагов', () => {
  const call = parseCall(event({ request: { method: 'tools/call', params: { name: 'news.search' } } }))
  assert.equal(toolName(call), 'news.search')
  assert.equal(toolName(parseCall(event({ method: 'initialize' }))), null)
  assert.equal(toolName(parseCall(event({ request: 'не json' }))), null)
})

test('тела становятся текстом один раз; отсутствующее тело — null, а не пустая строка', () => {
  const call = parseCall(event({ response: undefined }))
  assert.equal(call.response, null)
  assert.equal(typeof call.request, 'string')
  assert.equal(JSON.parse(call.request).params.name, 'file.read')
})

test('тело, пришедшее строкой, не переупаковывается', () => {
  assert.equal(parseCall(event({ response: '{"a": 1}  ' })).response, '{"a": 1}  ')
})

test('метка несёт код, длительность и размер; неизмеренного в ней нет', () => {
  assert.match(callMeta(parseCall(event())), /^HTTP 200 · 0,4 с · \d+ Б$/)
  assert.match(callMeta(parseCall(event({ status: undefined, ms: undefined }))), /^кода нет · \d+ Б$/)
})

test('нуля вместо неизмеренного не появляется', () => {
  assert.ok(!callMeta(parseCall(event({ ms: undefined }))).includes('0 мс'))
})

test('clipped от хоста отличается от обрезки страницы', () => {
  assert.equal(parseCall(event({ clipped: true })).clipped, true)
  assert.equal(parseCall(event({ clipped: 'да' })).clipped, false)
})

test('sha256 берётся из двух названных мест и больше ниоткуда', () => {
  assert.equal(sha256Of(JSON.stringify({ result: { sha256: HASH_A } })), HASH_A)
  assert.equal(sha256Of(JSON.stringify({ result: { structuredContent: { sha256: HASH_B } } })), HASH_B)
  // Похожая строка в другом месте ответа хешем не считается.
  assert.equal(sha256Of(JSON.stringify({ result: { content: [{ text: HASH_A }] } })), null)
  assert.equal(sha256Of(JSON.stringify({ result: { sha256: 'короткий' } })), null)
  assert.equal(sha256Of('не json'), null)
  assert.equal(sha256Of(null), null)
})

test('сверка хешей: третьего случая «наверное совпали» нет', () => {
  assert.equal(compareHashes(HASH_A, HASH_A).kind, 'ok')
  assert.equal(compareHashes(HASH_A, HASH_B).kind, 'bad')
  assert.equal(compareHashes(HASH_A, null).kind, 'unknown')
  assert.equal(compareHashes(null, null).kind, 'unknown')
  // Неизвестность не выдаётся за успех — это и есть предмет проверки.
  assert.notEqual(compareHashes(null, null).kind, 'ok')
})

// ——— слова модели между вызовами (ADR 2026-09-28-1852, заход 1) ———

const said = (over = {}) => ({
  round: 2,
  text: 'Сначала поищу новости, потом сохраню выжимку.',
  chosen: [{ server: 'mcpnews', tool: 'news.search' }],
  stopReason: 'tool_use',
  ...over,
})

test('слова круга разбираются: номер, текст, выбор парами «сервер и инструмент»', () => {
  const words = parseWords(said())
  assert.equal(words.round, 2)
  assert.equal(words.text, 'Сначала поищу новости, потом сохраню выжимку.')
  assert.deepEqual(words.chosen, [{ server: 'mcpnews', tool: 'news.search' }])
  assert.equal(wordsTitle(words), 'круг 2 · слова модели')
  assert.equal(picksLine(words), 'Выбрано: mcpnews · news.search')
})

test('текста у круга нет — на его месте слово, а не пустота', () => {
  const words = parseWords(said({ text: '' }))
  assert.equal(words.text, '')
  const shown = wordsText(words)
  // Сравнение с самой константой гипотез не различает: при NO_WORDS = ''
  // оно зелёное, а на экране пустота. Пустоту ловит эта строка.
  assert.match(shown, /\S/, `на месте слов модели пустота: ${JSON.stringify(shown)}`)
  assert.equal(shown, NO_WORDS)
  // И непустые слова заглушка не вытесняет.
  assert.equal(wordsText(parseWords(said())), said().text)
})

test('поля text не было вовсе — это тот же случай «без слов», а не отсутствие записи', () => {
  assert.equal(wordsText(parseWords(said({ text: undefined }))), NO_WORDS)
  assert.equal(wordsText(parseWords(undefined)), NO_WORDS)
})

test('инструментов на круге не названо — тоже слово (так выглядит заключительный круг)', () => {
  assert.equal(picksLine(parseWords(said({ chosen: [] }))), NO_PICKS)
  assert.match(NO_PICKS, /\S/)
})

test('имени сервера у выбранного инструмента нет — остаётся имя инструмента, выдуманного сервера нет', () => {
  const words = parseWords(said({ chosen: [{ tool: 'news.search' }] }))
  assert.deepEqual(words.chosen, [{ server: null, tool: 'news.search' }])
  assert.equal(picksLine(words), 'Выбрано: news.search')
})

test('номера круга нет — слово, а не ноль', () => {
  assert.equal(parseWords(said({ round: undefined })).round, null)
  assert.ok(wordsTitle(parseWords(said({ round: undefined }))).includes(NO_ROUND))
})

test('обрыв по длине не пропадает молча: у записи стоит пояснение, что инструменты не исполнялись', () => {
  const note = stopNote(parseWords(said({ stopReason: 'length' })))
  assert.match(note ?? '', /не исполнял/)
  // Прочие причины остановки записи не касаются — их место в сводке запуска.
  assert.equal(stopNote(parseWords(said())), null)
  assert.equal(stopNote(parseWords(said({ stopReason: null }))), null)
})
