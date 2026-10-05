// Копия правил показа тела не разъехалась с оригиналом дня 16.
//
// МЕТОД: сверяется ИСХОДНЫЙ ТЕКСТ каждой функции — `Function.prototype
// .toString()` возвращает ровно те байты, из которых функция была создана.
// Поэтому проверка слепа к порядку объявлений и к комментариям вокруг, но
// поймает любую правку внутри функции — в том числе правку одного знака в
// числе. Сверка «по имени экспорта» этого бы не поймала.
//
// Проверяется и ПОВЕДЕНИЕ на общей таблице входов: если однажды сверку текста
// придётся ослабить, поведенческая половина останется.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as mine from '../public/rpc.js'
import * as day16 from '../../day16/public/console.js'

const FUNCTIONS = ['bytesOf', 'clipBody', 'reindent', 'formatBytes', 'formatMs', 'formatTime']
const CONSTANTS = ['BODY_LIMIT', 'EMPTY_BODY']

test('исходный текст каждой общей функции совпадает с днём 16 знак в знак', () => {
  for (const name of FUNCTIONS) {
    assert.equal(typeof mine[name], 'function', `${name} не экспортирован`)
    assert.equal(typeof day16[name], 'function', `${name} нет у дня 16`)
    assert.equal(String(mine[name]), String(day16[name]), `${name} разъехался с днём 16`)
  }
})

test('общие постоянные совпадают с днём 16', () => {
  for (const name of CONSTANTS) assert.deepEqual(mine[name], day16[name], name)
})

test('тексты частичного результата совпадают с днём 16', () => {
  assert.equal(String(mine.partialNotes.clipped), String(day16.partialNotes.clipped))
  assert.equal(mine.partialNotes.clipped(200_000), day16.partialNotes.clipped(200_000))
  assert.equal(mine.partialNotes.notJson, day16.partialNotes.notJson)
})

test('поведение совпадает на общей таблице входов', () => {
  const texts = ['', '{}', '{"a":1}', 'не json', '{"a":"ц"}', 'x'.repeat(70_000), 'ц'.repeat(40_000)]
  for (const text of texts) {
    assert.deepEqual(mine.clipBody(text), day16.clipBody(text), `clipBody ${text.slice(0, 12)}`)
    assert.deepEqual(mine.reindent(text), day16.reindent(text), `reindent ${text.slice(0, 12)}`)
    assert.equal(mine.bytesOf(text), day16.bytesOf(text))
  }
  for (const n of [0, 1, 1023, 1024, 65_536]) assert.equal(mine.formatBytes(n), day16.formatBytes(n))
  for (const n of [0, 99, 100, 900, 20_000]) assert.equal(mine.formatMs(n), day16.formatMs(n))
  const t = new Date(Date.UTC(2026, 8, 28, 5, 7, 3))
  assert.equal(mine.formatTime(t), day16.formatTime(t))
})

test('обрезка режет по байтам, а не по знакам — кириллица весит два байта', () => {
  const cut = mine.clipBody('ц'.repeat(40_000))
  assert.equal(cut.truncated, true)
  assert.ok(mine.bytesOf(cut.text) <= mine.BODY_LIMIT)
  assert.equal(cut.text.length, mine.BODY_LIMIT / 2)
})
