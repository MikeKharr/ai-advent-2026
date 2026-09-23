// День 15, фаза 1: промпты профиля и текст промпта, ушедшего модели
// (ADR 2026-09-23-0646, пп. 1 и 4). Предмет проверки — две таблицы и три
// оператора удаления: «очистить», удаление профиля, уборка по сроку.
// Требует Node 24 или флага --experimental-sqlite.
//
// Каждая проверка удаления сначала убеждается, что строки в базе ЕСТЬ, и
// читает их тем же сырым доступом, которым потом считает нули: иначе «ноль
// после» удовлетворил бы и пустая таблица, и чужой файл, и опечатка в имени
// столбца. Файл базы у каждого теста свой (mkdtemp) и называется явно.

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { PROFILE_PROMPT_IDS } from '../src/params.js'
import { createSessions } from '../src/sessions.js'

const HOUR = 3600_000
const DAY = 24 * HOUR
/** Сессия дней 6–10: profile_id у неё NULL, ни один профиль ею не владеет. */
const LEGACY = '66666666-6666-4666-8666-666666666666'

function open(options = {}) {
  const file = join(mkdtempSync(join(tmpdir(), 'day15-')), 'sessions.db')
  const sessions = createSessions({
    file,
    ttlMs: 30 * HOUR,
    profileTtlMs: 30 * DAY,
    log: () => {},
    ...options,
  })
  // Предмет проверки — именно этот файл: сырой доступ ниже открывает его же,
  // и промах мимо файла виден здесь, а не в виде зелёного нуля строк.
  assert.equal(existsSync(file), true, 'база создана по названному пути')
  return { sessions, file }
}

const raw = (file) => new DatabaseSync(file)
const count = (db, table, where = '', ...args) =>
  db.prepare(`SELECT count(*) AS n FROM ${table} ${where}`).get(...args).n

const makeProfile = (sessions, name, at) => {
  const created = sessions.createProfile({ name, at })
  assert.equal(created.ok, true)
  return created.profile.id
}

const makeSession = (sessions, profileId, at) => {
  const created = sessions.createSession({ profileId, at })
  assert.equal(created.ok, true)
  return created.id
}

/** Запись этапа «Подготовка промпта»: круг запуска с текстом. */
const prepare = (sessions, { runId, sessionId, round = 1, at }) =>
  sessions.addRunPrompt({
    runId,
    sessionId,
    round,
    system: `системный промпт круга ${round}`,
    input: `рабочая память круга ${round}`,
    sha8: 'a1b2c3d4',
    tokens: 1234,
    at,
  })

// --- Таблицы: что именно завелось --------------------------------------

test('обе таблицы дня 15 заводятся, и старая база их догоняет без потерь', () => {
  const { sessions, file } = open()
  const profile = makeProfile(sessions, 'профиль')
  sessions.savePrompt({ profileId: profile, promptId: 'stage.answer', text: 'отвечай кратко' })
  sessions.addInvariant({ profileId: profile, text: 'без выдумок' })
  sessions.close()

  // Отрицательный контроль: база БЕЗ таблиц дня 15 — такой она была до этой
  // правки. Без этого шага проверка ниже не отличала бы «миграция завела
  // таблицы» от «они были всегда».
  const db = raw(file)
  db.exec('DROP TABLE profile_prompts; DROP TABLE run_prompts')
  assert.equal(count(db, "sqlite_master WHERE type = 'table' AND name = 'profile_prompts'"), 0)
  assert.equal(count(db, "sqlite_master WHERE type = 'table' AND name = 'run_prompts'"), 0)
  // Память дня 14 в этой же базе жива и до миграции, и после неё.
  assert.equal(count(db, 'profile_invariants'), 1)
  db.close()

  const again = createSessions({ file, ttlMs: 30 * HOUR, profileTtlMs: 30 * DAY, log: () => {} })
  const after = raw(file)
  assert.equal(count(after, 'profile_prompts'), 0, 'таблица вернулась пустой, а не с копией')
  assert.equal(count(after, 'run_prompts'), 0)
  assert.equal(count(after, 'profile_invariants'), 1, 'инварианты дня 14 миграция не тронула')
  assert.deepEqual(again.invariantsOf(profile).map((i) => i.text), ['без выдумок'])
  after.close()
  again.close()
})

// --- Критерий: промпты не стираются настройками дней 13 и 14 ------------

test('сохранение настроек дня 13/14 промпты профиля не трогает', () => {
  const { sessions, file } = open()
  const profile = makeProfile(sessions, 'общий профиль')
  for (const promptId of PROFILE_PROMPT_IDS) {
    assert.equal(sessions.savePrompt({ profileId: profile, promptId, text: `текст ${promptId}` }).ok, true)
  }
  const db = raw(file)
  assert.equal(count(db, 'profile_prompts'), 5, 'пять промптов записаны до сохранения настроек')

  // Тот самый оператор, который переписывает столбец целиком заново
  // (sessions.js, saveStagedSettings) — причина отдельной таблицы.
  assert.equal(
    sessions.saveStagedSettings({ profileId: profile, settings: { contextTokens: 32000 } }),
    true,
  )
  assert.equal(sessions.saveSettings({ profileId: profile, settings: { model: 'haiku' } }), true)

  assert.equal(count(db, 'profile_prompts'), 5, 'промпты пережили сохранение настроек')
  assert.equal(sessions.promptsOf(profile).get('stage.answer'), 'текст stage.answer')
  // И наоборот: промпт не просочился в настройки, которые читают дни 11–14.
  const row = db.prepare('SELECT settings, settings_staged FROM profiles WHERE id = ?').get(profile)
  assert.doesNotMatch(row.settings + row.settings_staged, /stage\.answer/)
  db.close()
  sessions.close()
})

test('сброс к умолчанию — удаление строки, а не пустой текст; повтор тоже успех', () => {
  const { sessions, file } = open()
  const profile = makeProfile(sessions, 'профиль')
  sessions.savePrompt({ profileId: profile, promptId: 'stage.verify.invariants', text: 'проверь' })
  const db = raw(file)
  assert.equal(count(db, 'profile_prompts'), 1, 'строка есть до сброса')

  const first = sessions.deletePrompt({ profileId: profile, promptId: 'stage.verify.invariants' })
  assert.deepEqual(first, { ok: true, removed: true })
  assert.equal(count(db, 'profile_prompts'), 0, 'строки нет — не пустой текст в ней')
  assert.equal(sessions.promptsOf(profile).has('stage.verify.invariants'), false)

  const second = sessions.deletePrompt({ profileId: profile, promptId: 'stage.verify.invariants' })
  assert.deepEqual(second, { ok: true, removed: false }, 'повторное «вернуть умолчание» — не отказ')
  db.close()
  sessions.close()
})

test('неизвестный promptId и мёртвый профиль строк не заводят', () => {
  const { sessions, file } = open()
  const profile = makeProfile(sessions, 'профиль')
  assert.deepEqual(sessions.savePrompt({ profileId: profile, promptId: 'stage.unknown', text: 'x' }), {
    ok: false,
    code: 'unknown_prompt',
  })
  assert.deepEqual(
    sessions.savePrompt({ profileId: 'нет-такого', promptId: 'stage.answer', text: 'x' }),
    { ok: false, code: 'no_profile' },
  )
  assert.deepEqual(sessions.deletePrompt({ profileId: profile, promptId: 'stage.unknown' }), {
    ok: false,
    code: 'unknown_prompt',
  })
  const db = raw(file)
  assert.equal(count(db, 'profile_prompts'), 0)
  db.close()
  sessions.close()
})

// --- Критерий выхода фазы: три оператора удаления -----------------------

test('«очистить» уносит текст промпта этого диалога и только его', () => {
  const { sessions, file } = open()
  const profile = makeProfile(sessions, 'профиль')
  const mine = makeSession(sessions, profile)
  const neighbour = makeSession(sessions, profile)
  sessions.append({ sessionId: mine, role: 'user', text: 'вопрос', tokens: 5 })
  assert.equal(prepare(sessions, { runId: 'run-1', sessionId: mine, round: 1 }), true)
  assert.equal(prepare(sessions, { runId: 'run-1', sessionId: mine, round: 2 }), true)
  assert.equal(prepare(sessions, { runId: 'run-2', sessionId: neighbour, round: 1 }), true)

  const db = raw(file)
  assert.equal(count(db, 'run_prompts'), 3, 'три круга записаны')
  assert.equal(count(db, 'run_prompts', 'WHERE session_id = ?', mine), 2)

  sessions.clear(mine)

  assert.equal(
    count(db, 'run_prompts', 'WHERE session_id = ?', mine),
    0,
    'текст промпта очищенного диалога снят',
  )
  assert.equal(
    count(db, 'run_prompts', 'WHERE session_id = ?', neighbour),
    1,
    'соседний диалог не тронут',
  )
  assert.deepEqual(sessions.runPromptsOf({ runId: 'run-1', sessionId: mine }), [])

  // Круг, доехавший после нажатия «очистить», переписку не оживляет: диалога
  // нет — писать некуда.
  assert.equal(prepare(sessions, { runId: 'run-1', sessionId: mine, round: 3 }), false)
  assert.equal(count(db, 'run_prompts', 'WHERE session_id = ?', mine), 0)
  db.close()
  sessions.close()
})

test('текст промпта читается только через свой диалог', () => {
  const { sessions } = open()
  const profile = makeProfile(sessions, 'профиль')
  const mine = makeSession(sessions, profile)
  const neighbour = makeSession(sessions, profile)
  prepare(sessions, { runId: 'run-1', sessionId: mine })

  assert.equal(sessions.runPromptsOf({ runId: 'run-1', sessionId: mine }).length, 1)
  assert.deepEqual(
    sessions.runPromptsOf({ runId: 'run-1', sessionId: neighbour }),
    [],
    'запуск чужого диалога текста не отдаёт',
  )
  sessions.close()
})

test('удаление профиля уносит его промпты и тексты промптов его диалогов', () => {
  const { sessions, file } = open()
  const mineProfile = makeProfile(sessions, 'мой')
  const otherProfile = makeProfile(sessions, 'чужой')
  const mine = makeSession(sessions, mineProfile)
  const other = makeSession(sessions, otherProfile)
  sessions.savePrompt({ profileId: mineProfile, promptId: 'stage.answer', text: 'мой промпт' })
  sessions.savePrompt({ profileId: mineProfile, promptId: 'invariant.draft', text: 'мой черновик' })
  sessions.savePrompt({ profileId: otherProfile, promptId: 'stage.answer', text: 'чужой промпт' })
  prepare(sessions, { runId: 'run-mine', sessionId: mine })
  prepare(sessions, { runId: 'run-other', sessionId: other })
  // Диалог дней 6–10 профилю не принадлежит и под оператор попасть не должен.
  sessions.append({ sessionId: LEGACY, role: 'user', text: 'день 7', tokens: 5 })
  prepare(sessions, { runId: 'run-legacy', sessionId: LEGACY })

  const db = raw(file)
  assert.equal(count(db, 'profile_prompts', 'WHERE profile_id = ?', mineProfile), 2)
  assert.equal(count(db, 'run_prompts'), 3)

  const removed = sessions.deleteProfile(mineProfile)
  assert.equal(removed.prompts, 2, 'удаление отчиталось о двух промптах профиля')
  assert.equal(removed.runPrompts, 1, 'и об одном тексте промпта его диалога')

  assert.equal(count(db, 'profile_prompts', 'WHERE profile_id = ?', mineProfile), 0)
  assert.equal(
    count(db, 'profile_prompts', 'WHERE profile_id = ?', otherProfile),
    1,
    'промпт чужого профиля цел',
  )
  assert.equal(count(db, 'run_prompts', 'WHERE session_id = ?', mine), 0)
  assert.equal(count(db, 'run_prompts', 'WHERE session_id = ?', other), 1, 'чужой диалог цел')
  assert.equal(count(db, 'run_prompts', 'WHERE session_id = ?', LEGACY), 1, 'дни 6–10 не тронуты')
  db.close()
  sessions.close()
})

test('уборка снимает текст промпта старше 30 дней и промпты исчезнувшего профиля', () => {
  let t = Date.parse('2026-09-01T00:00:00Z')
  const { sessions, file } = open({ now: () => t })
  const profile = makeProfile(sessions, 'профиль', t)
  const session = makeSession(sessions, profile, t)
  prepare(sessions, { runId: 'run-old', sessionId: session, at: t })
  const db = raw(file)
  // Промпты профиля, которого уже нет: осиротели в обход deleteProfile.
  db.prepare(
    'INSERT INTO profile_prompts (profile_id, prompt_id, text, updated_at) VALUES (?, ?, ?, ?)',
  ).run('нет-такого', 'stage.answer', 'бесхозный', t)
  // Текст промпта, чья сессия исчезла в обход clear: только срок его и снимет.
  db.prepare(
    `INSERT INTO run_prompts (run_id, session_id, round, system, input, sha8, tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('run-orphan', 'нет-такой-сессии', 1, 'сис', 'вход', 'ffffffff', 10, t)
  assert.equal(count(db, 'run_prompts'), 2, 'оба текста записаны до уборки')
  assert.equal(count(db, 'profile_prompts'), 1)

  // Двадцать девять дней: срок ещё не вышел.
  t += 29 * DAY
  sessions.sweep()
  assert.equal(
    count(db, 'run_prompts', 'WHERE run_id = ?', 'run-orphan'),
    1,
    'на 29-м дне текст ещё жив — иначе проверка срока ничего не мерила бы',
  )
  assert.equal(count(db, 'profile_prompts'), 0, 'промпты мёртвого профиля убраны сразу')

  t += 2 * DAY
  sessions.sweep()
  assert.equal(count(db, 'run_prompts', 'WHERE run_id = ?', 'run-orphan'), 0, 'на 31-м дне снят')
  db.close()
  sessions.close()
})

// --- Дни 13 и 14 не изменились ------------------------------------------

test('удаление профиля по-прежнему уносит память дней 11–14', () => {
  const { sessions, file } = open()
  const profile = makeProfile(sessions, 'профиль')
  const session = makeSession(sessions, profile)
  sessions.append({ sessionId: session, role: 'user', text: 'вопрос', tokens: 5 })
  sessions.addInvariant({ profileId: profile, text: 'без выдумок' })
  sessions.saveStagedSettings({ profileId: profile, settings: { contextTokens: 32000 } })

  const db = raw(file)
  assert.equal(count(db, 'messages'), 1)
  assert.equal(count(db, 'profile_invariants'), 1)

  const removed = sessions.deleteProfile(profile)
  assert.equal(removed.messages, 1)
  assert.equal(removed.invariants, 1)
  assert.equal(removed.sessions, 1)
  assert.equal(removed.profiles, 1)
  assert.equal(count(db, 'messages'), 0)
  assert.equal(count(db, 'profile_invariants'), 0)
  db.close()
  sessions.close()
})
