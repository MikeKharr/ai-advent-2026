// Правила чтения сводки — исполнением. Предмет один и он важнее остальных:
// ОТСУТСТВУЮЩЕЕ ЗНАЧЕНИЕ НЕ СТАНОВИТСЯ НУЛЁМ. «Стартов 0 из 6» читается как
// «планировщик жив и сегодня не стартовал»; если на самом деле поля не
// пришло, это ложь про работающую систему, а не про пустую ленту.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { UNKNOWN, enabledLine, formatBangkok, formatUsd, formatWhen, promptLine, runMeta, shapeDigest, startsLine } from '../public/digest.js'

const full = {
  job: { enabled: true, agent: 'mcp-agent', schedule: '0 */6 * * *', maxRunsPerDay: 6, prompt: 'Собери сводку. Сохрани файлом.' },
  nextRunAt: '2026-09-28T12:00:00.000Z',
  startsToday: 1,
  budgetLeftUsd: 0.41,
  dailyCostUsd: 0.5,
  running: { runId: 'run-7' },
  runs: [{ id: 'run-6', startedAt: '2026-09-28T06:00:00.000Z', status: 'succeeded', summary: 'текст', tokens: 4210, budgetLeftUsd: 0.41, trace: [{ server: 'mcpnews' }] }],
}

test('полная сводка разбирается в то, что рисует страница', () => {
  const d = shapeDigest(full)
  assert.equal(d.enabled, true)
  assert.equal(d.maxRunsPerDay, 6)
  assert.equal(d.runningRunId, 'run-7')
  assert.equal(d.runs.length, 1)
  assert.equal(d.runs[0].trace.length, 1)
})

test('пустой ответ не превращается в нули', () => {
  const d = shapeDigest({})
  assert.equal(d.startsToday, null)
  assert.equal(d.maxRunsPerDay, null)
  assert.equal(d.budgetLeftUsd, null)
  assert.equal(d.enabled, null)
  assert.deepEqual(d.runs, [])
})

test('строка «стартов сегодня» не собирается, пока неизвестна любая её половина', () => {
  assert.equal(startsLine({ startsToday: 1, maxRunsPerDay: 6 }), '1 из 6')
  assert.equal(startsLine({ startsToday: 1, maxRunsPerDay: null }), UNKNOWN)
  assert.equal(startsLine({ startsToday: null, maxRunsPerDay: 6 }), UNKNOWN)
  // Нуль стартов — настоящее значение и он показывается как значение.
  assert.equal(startsLine({ startsToday: 0, maxRunsPerDay: 6 }), '0 из 6')
})

test('выключенный планировщик и неизвестное состояние — разные слова', () => {
  assert.equal(enabledLine(true), 'включён')
  assert.equal(enabledLine(false), 'выключен')
  assert.equal(enabledLine(null), UNKNOWN)
  assert.notEqual(enabledLine(null), enabledLine(false))
})

test('остаток бюджета: нуль — это нуль, отсутствие — слово', () => {
  assert.equal(formatUsd(0), '$0.00')
  assert.equal(formatUsd(0.41), '$0.41')
  assert.equal(formatUsd(null), UNKNOWN)
})

test('срок считается по UTC, а не по часам браузера', () => {
  assert.equal(formatWhen('2026-09-28T12:00:00.000Z'), '2026-09-28 12:00 UTC')
  assert.equal(formatWhen('не дата'), UNKNOWN)
  assert.equal(formatWhen(null), UNKNOWN)
})

test('подпись сводки не выдумывает статус и не подставляет ноль токенов', () => {
  const bare = shapeDigest({ runs: [{ id: 'run-1' }] }).runs[0]
  const line = runMeta(bare)
  assert.ok(line.includes(UNKNOWN))
  assert.ok(!line.includes('0 токенов'))
})

test('чужие типы полей не проходят за значения', () => {
  const d = shapeDigest({ startsToday: '3', job: { enabled: 'да', maxRunsPerDay: 6.5 }, budgetLeftUsd: '0.4', runs: 'нет' })
  assert.equal(d.startsToday, null)
  assert.equal(d.enabled, null)
  assert.equal(d.maxRunsPerDay, null)
  assert.equal(d.budgetLeftUsd, null)
  assert.deepEqual(d.runs, [])
})

// Срок показывается по Бангкоку — это единственное место, где время уходит из
// UTC, и уходит только для показа.
test('срок следующего запуска — по Бангкоку и с названием пояса в строке', () => {
  assert.equal(formatBangkok('2026-09-28T12:00:00.000Z'), '2026-09-28 19:00 Бангкок')
  // Пояс обязан быть назван: «19:00» без него не отличить от UTC.
  assert.ok(formatBangkok('2026-09-28T12:00:00.000Z').includes('Бангкок'))
  // Смещение — не ноль: строка UTC и строка Бангкока обязаны различаться.
  assert.notEqual(formatBangkok('2026-09-28T12:00:00.000Z'), formatWhen('2026-09-28T12:00:00.000Z'))
})

test('перевод пояса переносит и сутки, а не только часы', () => {
  // 21:30 UTC — это уже следующий день в Бангкоке. Сложение часов без переноса
  // даты дало бы 28-е число, и срок на экране отставал бы на сутки.
  assert.equal(formatBangkok('2026-09-28T21:30:00.000Z'), '2026-09-29 04:30 Бангкок')
  // Полночь по Бангкоку — 00, а не 24: час пишется в цикле h23.
  assert.equal(formatBangkok('2026-09-28T17:00:00.000Z'), '2026-09-29 00:00 Бангкок')
})

test('неизвестный срок не превращается ни в «сейчас», ни в прочерк', () => {
  assert.equal(formatBangkok(null), UNKNOWN)
  assert.equal(formatBangkok('не дата'), UNKNOWN)
})

// Запрос — предмет показа, а не украшение: посетитель по нему судит, что
// именно работа спрашивает. Отсюда два требования: показывать его целиком и
// не подменять отсутствие пустотой.
test('запрос показывается целиком, без обрезания', () => {
  const d = shapeDigest(full)
  assert.equal(d.prompt, 'Собери сводку. Сохрани файлом.')
  assert.equal(promptLine(d.prompt), full.job.prompt)
})

test('непришедший запрос назван словом, а не пустотой и не прочерком', () => {
  assert.equal(shapeDigest({}).prompt, null)
  assert.equal(promptLine(null), UNKNOWN)
  // Именно словом: пустая строка и прочерк на экране читались бы как «запроса нет».
  assert.notEqual(promptLine(null), '')
  assert.notEqual(promptLine(null), '—')
  // Чужой тип за запрос не проходит: число в рамке выглядело бы запросом.
  assert.equal(shapeDigest({ job: { prompt: 42 } }).prompt, null)
  assert.equal(shapeDigest({ job: { prompt: '' } }).prompt, null)
})
