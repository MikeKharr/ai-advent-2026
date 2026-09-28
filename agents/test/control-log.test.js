// Поверхность управления: журнал обращений (ADR 2026-09-28-1820, п. 2, ▲).
// Требует Node 24 или флага --experimental-sqlite.
//
// СОСТАВ — решение владельца при приёмке ADR: с текстами, 30 суток. П. 2 ADR
// писался под «без текстов» и после решения переписан не был; реализовано по
// приёмке.
//
// Следствие проверяется здесь же: раз в журнале лежат тексты посетителей,
// уборка по сроку — не гигиена таблицы, а исполнение обязанности. Каждая
// проверка удаления сначала убеждается, что строки ЕСТЬ, и читает их тем же
// сырым доступом, которым потом считает нули: иначе «ноль после»
// удовлетворила бы и пустая таблица, и промах мимо файла.

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { createControlLog, utcDay } from '../src/control/log.js'

const DAY = 24 * 3600_000
const tmp = () => join(mkdtempSync(join(tmpdir(), 'control-')), 'control-log.db')

function open(keepDays = 30, now = Date.now) {
  const file = tmp()
  const log = createControlLog({ file, keepDays, now })
  assert.equal(existsSync(file), true, 'база журнала создана по названному пути')
  return { log, file }
}

const rows = (file) => {
  const db = new DatabaseSync(file)
  const out = db.prepare('SELECT * FROM control_log ORDER BY id').all()
  db.close()
  return out
}

test('успех и отказ дают по строке, и обе одного вида', () => {
  const { log, file } = open()
  log.write({ op: 'profiles', outcome: 'ok', ms: 3, remote: '10.0.0.7' })
  log.write({ op: '-', outcome: 'unauthorized', ms: 1, remote: '10.0.0.9' })
  log.close()

  const all = rows(file)
  assert.equal(all.length, 2)
  assert.deepEqual(
    all.map((r) => [r.op, r.outcome, r.remote]),
    [
      ['profiles', 'ok', '10.0.0.7'],
      ['-', 'unauthorized', '10.0.0.9'],
    ],
  )
  // Адрес у отказа есть: без него залп был бы виден, но безымянен.
  assert.equal(all[1].remote, '10.0.0.9')
})

test('предъявленного значения ключа в строке нет, и передать его некуда', () => {
  const { log, file } = open()
  const presented = 'ПРЕДЪЯВЛЕННЫЙ-КЛЮЧ'
  // Так выглядит попытка протащить значение: `write` такого поля не знает.
  log.write({ op: '-', outcome: 'unauthorized', ms: 1, remote: 'x', key: presented })
  log.close()
  const dump = JSON.stringify(rows(file))
  assert.equal(dump.includes(presented), false)
})

test('тексты сообщений посетителей в журнале есть — решение владельца при приёмке', () => {
  const { log, file } = open()
  log.write({
    op: 'message.send',
    outcome: 'ok',
    ms: 900,
    paid: true,
    profileId: 'p-1',
    remote: '10.0.0.7',
    texts: { text: 'что нового в финтехе' },
  })
  log.close()
  const [row] = rows(file)
  assert.equal(JSON.parse(row.texts).text, 'что нового в финтехе')
  assert.equal(row.paid, 1)
  assert.equal(row.profile_id, 'p-1')
})

test('уборка снимает строки старше 30 суток и не трогает свежие', () => {
  let clock = Date.parse('2026-09-29T12:00:00.000Z')
  const { log, file } = open(30, () => clock)
  log.write({ at: clock - 31 * DAY, op: 'message.send', outcome: 'ok', ms: 1, texts: { text: 'старое' } })
  log.write({ at: clock - 29 * DAY, op: 'message.send', outcome: 'ok', ms: 1, texts: { text: 'свежее' } })
  // Строки ЕСТЬ до уборки: без этого шага зелёный ноль после неё
  // удовлетворила бы и пустая таблица.
  assert.equal(rows(file).length, 2)

  assert.equal(log.prune(), 1)
  const left = rows(file)
  assert.equal(left.length, 1)
  assert.equal(JSON.parse(left[0].texts).text, 'свежее')
  log.close()
})

test('суточный счётчик платных вызовов переживает перезапуск процесса', () => {
  const clock = Date.parse('2026-09-29T12:00:00.000Z')
  const file = tmp()
  const first = createControlLog({ file, keepDays: 30, now: () => clock })
  first.takePaidSlot()
  first.takePaidSlot()
  assert.equal(first.paidToday(), 2)
  first.close()

  // Перезапуск: объект новый, файл тот же. Счётчик в памяти обнулился бы.
  const second = createControlLog({ file, keepDays: 30, now: () => clock })
  assert.equal(second.paidToday(), 2)
  // Новые сутки UTC считаются заново.
  assert.equal(second.paidToday(clock + DAY), 0)
  second.close()
})

test('сутки счётчика — UTC по построению, а не по локали процесса', () => {
  // 23:30 UTC 29-го — это уже 30-е в Бангкоке (+07). Ключ обязан остаться 29-м.
  assert.equal(utcDay(Date.parse('2026-09-29T23:30:00.000Z')), '2026-09-29')
  assert.equal(utcDay(Date.parse('2026-09-30T00:30:00.000Z')), '2026-09-30')
})
