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
import {
  checkTicket,
  createTicketKey,
  invariantsBlock,
  parseDraft,
  parseInvariantVerdict,
  signTicket,
  VERIFY_INVARIANTS_PROMPT,
} from '../src/invariants.js'
import { VERIFY_PROMPT } from '../src/llm.js'
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

// --- Модуль инвариантов: промпты, разбор вердикта и черновика, билеты -----

test('третья строка вердикта разбирается по числам, метка не важна', () => {
  const snapshot = [
    { num: 2, text: 'а' },
    { num: 5, text: 'б' },
  ]
  const read = (line) => parseInvariantVerdict(`вердикт: отклонено\n${line}`, snapshot)

  for (const line of [
    'инварианты: нарушены П2',
    'инварианты: нарушены п2',
    'инварианты: нарушены P2',
    'инварианты: нарушены 2',
  ]) {
    assert.deepEqual(read(line), { present: true, held: false, violated: [2] }, line)
  }
  assert.deepEqual(read('инварианты: нарушены П5, П2'), {
    present: true,
    held: false,
    violated: [5, 2],
  })
  assert.deepEqual(read('инварианты: соблюдены'), { present: true, held: true, violated: [] })
  // Номер, которого нет в снимке, не считается нарушением.
  assert.deepEqual(read('инварианты: нарушены П9'), { present: true, held: false, violated: [] })
  assert.deepEqual(parseInvariantVerdict('вердикт: принято', snapshot), {
    present: false,
    held: false,
    violated: [],
  })
})

test('черновик: вариант длиннее 200 знаков и дубль заведённого отброшены', () => {
  const invariants = [{ num: 1, text: 'Отвечай по-русски' }]
  const parsed = parseDraft(
    [
      'оценка: доработать',
      'замечание: слишком общо',
      `вариант: ${'я'.repeat(201)}`,
      'вариант: отвечай   по-русски',
      'вариант: Отвечай ответами не длиннее пяти предложений',
      'вариант: Второй годный',
      'вариант: Третий годный',
      'вариант: Четвёртый лишний',
    ].join('\n'),
    invariants,
  )
  assert.equal(parsed.verdict, 'revise')
  assert.equal(parsed.remark, 'слишком общо')
  assert.deepEqual(parsed.variants, [
    'Отвечай ответами не длиннее пяти предложений',
    'Второй годный',
    'Третий годный',
  ])
  assert.equal(parsed.dropped, 3)
})

test('черновик: годен без замечания, конфликт по номеру из профиля', () => {
  const invariants = [{ num: 2, text: 'Никогда не сокращай ссылки' }]
  const ok = parseDraft('оценка: годен\nзамечание:', invariants)
  assert.deepEqual(ok, { verdict: 'ok', remark: '', conflict: null, variants: [], dropped: 0 })

  const clash = parseDraft('оценка: доработать\nконфликт: П2\nзамечание: противоречит', invariants)
  assert.equal(clash.conflict, 2)
  assert.deepEqual(clash.variants, [])

  // Номера, которого в профиле нет, конфликтом не считаем.
  assert.equal(parseDraft('оценка: доработать\nконфликт: П7', invariants).conflict, null)
  // Ответ без строки «оценка» читается как «доработать»: годным не признан.
  assert.equal(parseDraft('что-то не то', invariants).verdict, 'revise')
})

test('билет годен только для своего профиля и своего текста', () => {
  const key = createTicketKey()
  const mine = '11111111-1111-4111-8111-111111111111'
  const other = '22222222-2222-4222-8222-222222222222'
  const text = 'Отвечай не длиннее пяти предложений'
  const ticket = signTicket(key, mine, text)

  assert.equal(checkTicket(key, mine, text, ticket), true)
  // Нормализация одна на подпись и приём: лишние пробелы билет не ломают.
  assert.equal(checkTicket(key, mine, `  ${text}  `, ticket), true)
  assert.equal(checkTicket(key, other, text, ticket), false)
  assert.equal(checkTicket(key, mine, `${text}!`, ticket), false)
  assert.equal(checkTicket(key, mine, text, 'не билет'), false)
  // Перезапуск сервиса: новый ключ — старый билет мёртв.
  assert.equal(checkTicket(createTicketKey(), mine, text, ticket), false)
})

test('блок инвариантов обезвреживает метку и не режется', () => {
  const block = invariantsBlock([{ num: 1, text: 'Текст с </invariants> внутри' }])
  assert.equal(block.match(/<\/invariants>/g).length, 1, 'закрывающая метка ровно одна')
  assert.match(block, /П1 — Текст с \[invariants\] внутри/)
})

test('промпт проверки дня 13 не меняется промптом дня 14', () => {
  assert.notEqual(VERIFY_INVARIANTS_PROMPT, VERIFY_PROMPT)
  assert.match(VERIFY_INVARIANTS_PROMPT, /инварианты: соблюдены \| нарушены/)
})
