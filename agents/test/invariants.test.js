// День 14: инварианты профиля (ADR 2026-09-22-0827).
// Хранилище — критерий 2 и 10; формулировщик и ворота — критерии 3 и 3а;
// этапы машины — критерии 4–9.
// Требует Node 24 или флага --experimental-sqlite.

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { createSessions } from '../src/sessions.js'

const HOUR = 3600_000
const DAY = 24 * HOUR

function open() {
  const file = join(mkdtempSync(join(tmpdir(), 'day14-')), 'sessions.db')
  const sessions = createSessions({
    file,
    ttlMs: 30 * HOUR,
    profileTtlMs: 30 * DAY,
    log: () => {},
  })
  return { sessions, file }
}

const newProfile = (sessions) => sessions.createProfile({ name: 'Тест' }).profile.id

test('номер инварианта — max + 1, удалённый номер не переиспользуется', () => {
  const { sessions } = open()
  const profileId = newProfile(sessions)

  assert.deepEqual(sessions.invariantsOf(profileId), [])
  for (const text of ['Первое', 'Второе', 'Третье']) {
    assert.equal(sessions.addInvariant({ profileId, text }).ok, true)
  }
  assert.deepEqual(
    sessions.invariantsOf(profileId).map((i) => [i.num, i.text]),
    [
      [1, 'Первое'],
      [2, 'Второе'],
      [3, 'Третье'],
    ],
  )

  assert.equal(sessions.deleteInvariant({ profileId, num: 2 }), true)
  assert.equal(sessions.deleteInvariant({ profileId, num: 2 }), false)
  const next = sessions.addInvariant({ profileId, text: 'Четвёртое' })
  assert.equal(next.invariant.num, 4, 'после удаления П2 следующий — П4, не П2')
  sessions.close()
})

test('одиннадцатый инвариант — invariants_full, дубль без учёта регистра — duplicate', () => {
  const { sessions } = open()
  const profileId = newProfile(sessions)
  for (let i = 1; i <= 10; i++) {
    assert.equal(sessions.addInvariant({ profileId, text: `Правило ${i}` }).ok, true)
  }
  assert.deepEqual(sessions.addInvariant({ profileId, text: 'Одиннадцатое' }), {
    ok: false,
    code: 'invariants_full',
  })

  sessions.deleteInvariant({ profileId, num: 1 })
  assert.deepEqual(sessions.addInvariant({ profileId, text: 'пРаВиЛо 2' }), {
    ok: false,
    code: 'duplicate',
  })
  assert.equal(sessions.addInvariant({ profileId, text: 'Правило 1' }).ok, true)
  sessions.close()
})

test('инвариант чужого профиля не заводится и не удаляется', () => {
  const { sessions } = open()
  assert.deepEqual(
    sessions.addInvariant({ profileId: '11111111-1111-4111-8111-111111111111', text: 'X' }),
    { ok: false, code: 'no_profile' },
  )
  assert.equal(
    sessions.deleteInvariant({ profileId: '11111111-1111-4111-8111-111111111111', num: 1 }),
    false,
  )
  sessions.close()
})

test('удаление профиля не оставляет строк в profile_invariants', () => {
  const { sessions, file } = open()
  const profileId = newProfile(sessions)
  const other = newProfile(sessions)
  sessions.addInvariant({ profileId, text: 'Уйдёт с профилем' })
  sessions.addInvariant({ profileId: other, text: 'Останется' })

  const removed = sessions.deleteProfile(profileId)
  assert.equal(removed.invariants, 1)

  const db = new DatabaseSync(file)
  const rows = db.prepare('SELECT profile_id FROM profile_invariants').all()
  assert.deepEqual(
    rows.map((r) => r.profile_id),
    [other],
  )
  db.close()
  sessions.close()
})

test('profile() отдаёт инварианты, а уборка снимает сирот', () => {
  const { sessions, file } = open()
  const profileId = newProfile(sessions)
  sessions.addInvariant({ profileId, text: 'Видно в профиле' })
  assert.deepEqual(
    sessions.profile(profileId).invariants.map((i) => i.text),
    ['Видно в профиле'],
  )

  // Сирота: строка профиля, удалённого в обход транзакции.
  const db = new DatabaseSync(file)
  db.prepare('DELETE FROM profiles WHERE id = ?').run(profileId)
  db.close()
  sessions.sweep()
  const check = new DatabaseSync(file)
  assert.equal(check.prepare('SELECT count(*) AS n FROM profile_invariants').get().n, 0)
  check.close()
  sessions.close()
})
