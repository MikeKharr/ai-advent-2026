// Миграция дня 11 на копии базы дней 7–10 (ADR 2026-09-15-2024, п. 10,
// критерий 1). Фикстура `fixtures/day7-10-sessions.sql` снята выгрузкой с
// базы, созданной кодом до этой правки: схема там дореформенная, и столбцов
// профиля в ней нет. Требует Node 24 или флага --experimental-sqlite.

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createSessions } from '../src/sessions.js'

const here = dirname(fileURLToPath(import.meta.url))
const DUMP = readFileSync(join(here, 'fixtures', 'day7-10-sessions.sql'), 'utf8')

const DAY7 = '77777777-7777-4777-8777-777777777777'
const DAY9 = '99999999-9999-4999-8999-999999999999'
const DAY10 = '10101010-1010-4010-8010-101010101010'
/** Час последней записи фикстуры: от него считаются сроки хранения. */
const FIXTURE_AT = 1_757_000_012_000

/** Копия базы дней 7–10 в отдельном файле: фикстура остаётся нетронутой. */
function copy() {
  const file = join(mkdtempSync(join(tmpdir(), 'day7-10-')), 'sessions.db')
  const db = new DatabaseSync(file)
  db.exec(DUMP)
  db.close()
  return file
}

const columns = (db, table) =>
  db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name)

test('до миграции столбцов профиля в копии нет — фикстура действительно старая', () => {
  const db = new DatabaseSync(copy())
  assert.equal(columns(db, 'sessions').includes('profile_id'), false)
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'profiles'").get().n,
    0,
    'таблицы профилей в базе дней 7–10 нет',
  )
  db.close()
})

test('после миграции переписка дней 7–10 читается ровно как прежде', () => {
  const file = copy()
  const sessions = createSessions({ file, ttlMs: 30 * 3600_000, log: () => {} })

  // День 7: линейная переписка, запись об отказе в контекст не идёт.
  assert.equal(sessions.history(DAY7).length, 3)
  assert.deepEqual(
    sessions.path(DAY7).map((m) => m.text),
    ['что нового в финтехе', 'Вот дайджест по финтеху'],
  )
  assert.equal(sessions.totalTokens(DAY7), 520, 'отказ в сумму не входит')
  assert.equal(sessions.head(DAY7), null, 'у линейной сессии головы нет')

  // День 9: сводка с якорем и накопленная цена вызовов.
  const summary = sessions.summary(DAY9)
  assert.equal(summary.text, 'Обсудили раунды недели и Индию')
  assert.equal(summary.tokens, 30)
  assert.equal(summary.throughId, 5)
  assert.deepEqual(sessions.context(DAY9), {
    total: 41,
    summaryTokens: 30,
    freshTokens: 11,
  })
  assert.equal(sessions.totalTokens(DAY9), 1700, 'ответы плюс цена сводки')

  // День 10: дерево, голова и липкие факты; брошенная ветка вне пути.
  assert.equal(sessions.head(DAY10), 10)
  assert.deepEqual(
    sessions.path(DAY10).map((m) => m.id),
    [7, 8, 9, 10],
  )
  assert.equal(
    sessions.path(DAY10).some((m) => m.text === 'вопрос В'),
    false,
    'сестринская ветка в путь не входит',
  )
  assert.equal(sessions.facts(DAY10).tokens, 25)
  assert.equal(sessions.totalTokens(DAY10), 2210)
  assert.deepEqual(sessions.context(DAY10, { strategy: 'window', windowSize: 2 }), {
    total: 65,
    messages: 2,
    windowSize: 2,
  })
  sessions.close()
})

test('старые строки получают NULL, а профили и темы появляются пустыми', () => {
  const file = copy()
  const sessions = createSessions({ file, ttlMs: 30 * 3600_000, log: () => {} })
  assert.deepEqual(sessions.profiles(), [], 'профилей в мигрированной базе нет')
  sessions.close()

  const db = new DatabaseSync(file)
  for (const column of ['profile_id', 'topic_id', 'pending_topic']) {
    assert.ok(columns(db, 'sessions').includes(column), `столбец ${column} добавлен`)
  }
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM sessions WHERE profile_id IS NOT NULL').get().n,
    0,
    'все сессии дней 6–10 остались без профиля',
  )
  for (const table of ['profiles', 'personalization', 'topics', 'topic_facts']) {
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, `${table} пуста`)
  }
  // Индекс по профилю создаётся после столбца — в старой базе его колонки нет.
  assert.ok(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .some((r) => r.name === 'sessions_by_profile'),
  )
  db.close()
})

test('миграция идемпотентна: повторное открытие той же базы ничего не ломает', () => {
  const file = copy()
  const first = createSessions({ file, ttlMs: 30 * 3600_000, log: () => {} })
  const before = first.history(DAY10).map((m) => m.id)
  first.close()

  const second = createSessions({ file, ttlMs: 30 * 3600_000, log: () => {} })
  const third = createSessions({ file, ttlMs: 30 * 3600_000, log: () => {} })
  assert.deepEqual(third.history(DAY10).map((m) => m.id), before)
  assert.equal(third.head(DAY10), 10)
  second.close()
  third.close()
})

test('уборка после миграции сессии дней 7–10 по чужому сроку не трогает', () => {
  const file = copy()
  // Через час после последней записи фикстуры: 30 часов ещё не прошло.
  const sessions = createSessions({
    file,
    ttlMs: 30 * 3600_000,
    now: () => FIXTURE_AT + 3600_000,
    log: () => {},
  })
  assert.equal(sessions.sweep(), 0, 'ни одна сессия не истекла')
  assert.equal(sessions.history(DAY7).length, 3)
  assert.equal(sessions.history(DAY9).length, 3)
  assert.equal(sessions.history(DAY10).length, 5)
  assert.ok(sessions.summary(DAY9), 'сводка на месте')
  assert.ok(sessions.facts(DAY10), 'факты стратегии на месте')
  sessions.close()
})


// Решение владельца 2026-09-21 (вариант «а»): настройки дня 13, попавшие в
// общий блок прежней реализацией, переезжают в свой столбец при открытии базы.

const seedProfile = (file, id, settings) => {
  const seed = new DatabaseSync(file)
  seed.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, settings TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
    );
  `)
  seed
    .prepare(
      'INSERT INTO profiles (id, name, settings, created_at, last_seen_at) VALUES (?,?,?,?,?)',
    )
    .run(id, 'Мика', JSON.stringify(settings), FIXTURE_AT, FIXTURE_AT)
  seed.close()
}

test('миграция: значения дня 13 уходят из общего блока в settings_staged', () => {
  const file = copy()
  const id = '12121212-1212-4212-8212-121212121212'
  seedProfile(file, id, {
    strategy: 'summary',
    contextTokens: 32_000,
    summarizeAt: 20_000,
    reviewModel: 'kimi-k3',
    reviewRounds: 3,
  })

  const sessions = createSessions({ file, ttlMs: 30 * 3600_000, log: () => {} })
  const profile = sessions.profile(id, FIXTURE_AT)
  assert.deepEqual(profile.settings, { strategy: 'summary' }, 'день 11 видит только своё')
  assert.deepEqual(profile.stagedSettings, {
    contextTokens: 32_000,
    summarizeAt: 20_000,
    reviewModel: 'kimi-k3',
    reviewRounds: 3,
  })
  sessions.close()
})

test('миграция не трогает законные значения дня 11', () => {
  const file = copy()
  const id = '13131313-1313-4313-8313-131313131313'
  const settings = { strategy: 'window', contextTokens: 8000, summarizeAt: 8000, window: 5 }
  seedProfile(file, id, settings)

  const sessions = createSessions({ file, ttlMs: 30 * 3600_000, log: () => {} })
  const profile = sessions.profile(id, FIXTURE_AT)
  assert.deepEqual(profile.settings, settings)
  assert.deepEqual(profile.stagedSettings, {})
  sessions.close()
})

test('миграция не затирает уже записанные настройки дня 13', () => {
  const file = copy()
  const id = '14141414-1414-4414-8414-141414141414'
  seedProfile(file, id, { reviewRounds: 3, contextTokens: 32_000 })
  // Столбец появляется при первом открытии; затем в нём — выбор дня 13.
  const first = createSessions({ file, ttlMs: 30 * 3600_000, log: () => {} })
  first.saveStagedSettings({ profileId: id, settings: { reviewRounds: 1 }, at: FIXTURE_AT })
  first.close()
  // Возвращаем в общий блок то, что миграция уже убирала: так выглядит база,
  // побывавшая под прежней реализацией после правки настроек.
  const seed = new DatabaseSync(file)
  seed
    .prepare('UPDATE profiles SET settings = ? WHERE id = ?')
    .run(JSON.stringify({ reviewRounds: 3, strategy: 'window' }), id)
  seed.close()

  const sessions = createSessions({ file, ttlMs: 30 * 3600_000, log: () => {} })
  const profile = sessions.profile(id, FIXTURE_AT)
  assert.deepEqual(profile.settings, { strategy: 'window' }, 'чужое значение из блока убрано')
  assert.deepEqual(profile.stagedSettings, { reviewRounds: 1 }, 'записанный выбор не затёрт')
  sessions.close()
})
