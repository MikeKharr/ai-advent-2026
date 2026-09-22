// День 14: инварианты профиля (ADR 2026-09-22-0827).
// Хранилище — критерий 2 и 10; формулировщик и ворота — критерии 3 и 3а;
// этапы машины — критерии 4–9.
// Требует Node 24 или флага --experimental-sqlite.

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import {
  checkTicket,
  createInvariants,
  createTicketKey,
  invariantsBlock,
  parseDraft,
  parseInvariantVerdict,
  signTicket,
  VERIFY_INVARIANTS_PROMPT,
} from '../src/invariants.js'
import { VERIFY_PROMPT } from '../src/llm.js'
import { createRuns } from '../src/runs.js'
import { createService } from '../src/service.js'
import { createSessions } from '../src/sessions.js'
import { ENV } from './fixtures.js'

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

// --- Ручки сервиса: ворота, приём, удаление (критерии 3, 3а, 11) ---------

/** Поддельный роутер формулировщика: один ответ на ход, вызовы считаются. */
function draftRouter(replies) {
  const calls = []
  let no = 0
  const impl = async (url, options = {}) => {
    calls.push(JSON.parse(options.body))
    const text = replies[Math.min(no++, replies.length - 1)]
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        text,
        provider: { id: 'anthropic-haiku', model: 'claude-haiku-4-5' },
        truncated: false,
        usage: { inputTokens: 300, outputTokens: 60 },
      }),
    }
  }
  impl.calls = calls
  return impl
}

async function serveInvariants(replies = ['оценка: годен\nзамечание:']) {
  const { sessions } = open()
  const fetchImpl = draftRouter(replies)
  const invariants = createInvariants({ sessions })
  const server = createServer(
    createService({
      agents: new Map(),
      archive: { state: () => ({}) },
      runs: createRuns(),
      sessions,
      invariants,
      env: ENV,
      fetchImpl,
      log: () => {},
    }),
  )
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  server.unref()
  const base = `http://127.0.0.1:${server.address().port}`
  const auth = { authorization: 'Bearer agent-key' }
  const call = (method, path, body) =>
    fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? auth : { ...auth, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const profileId = newProfile(sessions)
  return {
    sessions,
    invariants,
    fetchImpl,
    profileId,
    draft: (text, id = profileId) => call('POST', `/v1/profiles/${id}/invariants/draft`, { text }),
    accept: (body, id = profileId) => call('POST', `/v1/profiles/${id}/invariants`, body),
    del: (num, id = profileId) => call('DELETE', `/v1/profiles/${id}/invariants/${num}`),
    get: (id = profileId) => call('GET', `/v1/profiles/${id}`),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test('черновик «годен»: билет у самого текста, один вызов Haiku на ход', async () => {
  const s = await serveInvariants(['оценка: годен\nзамечание:'])
  const response = await s.draft('Отвечай не длиннее пяти предложений')
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.draft.verdict, 'ok')
  assert.equal(body.draft.text, 'Отвечай не длиннее пяти предложений')
  assert.match(body.draft.ticket, /^[0-9a-f]{64}$/)
  assert.equal(s.fetchImpl.calls.length, 1, 'один вызов на ход')
  assert.equal(s.fetchImpl.calls[0].provider, 'anthropic-haiku')
  assert.equal(s.fetchImpl.calls[0].taskClass, 'summarize')

  const accepted = await s.accept({ text: body.draft.text, ticket: body.draft.ticket })
  assert.equal(accepted.status, 200)
  assert.deepEqual((await accepted.json()).invariant.num, 1)
  assert.equal(s.fetchImpl.calls.length, 1, 'приём модель не зовёт')
  await s.close()
})

test('черновик «доработать»: билет у каждого варианта, у черновика — нет', async () => {
  const s = await serveInvariants([
    'оценка: доработать\nзамечание: слишком общо\nвариант: Отвечай не длиннее пяти предложений\nвариант: Отвечай одним абзацем',
  ])
  const body = await (await s.draft('пиши покороче')).json()

  assert.equal(body.draft.verdict, 'revise')
  assert.equal(body.draft.text, null, 'у черновика билета нет')
  assert.equal(body.draft.ticket, null)
  assert.equal(body.draft.variants.length, 2)
  for (const variant of body.draft.variants) assert.match(variant.ticket, /^[0-9a-f]{64}$/)

  const accepted = await s.accept(body.draft.variants[1])
  assert.equal(accepted.status, 200)
  assert.equal((await accepted.json()).invariant.text, 'Отвечай одним абзацем')
  await s.close()
})

test('POST без билета и с чужим билетом — 400 no_ticket', async () => {
  const s = await serveInvariants()
  const text = 'Отвечай не длиннее пяти предложений'

  const bare = await s.accept({ text })
  assert.equal(bare.status, 400)
  assert.equal((await bare.json()).code, 'no_ticket')

  // Билет того же текста, но другого профиля.
  const other = newProfile(s.sessions)
  const foreign = await s.accept({ text, ticket: s.invariants.ticket(other, text) })
  assert.equal(foreign.status, 400)
  assert.equal((await foreign.json()).code, 'no_ticket')

  // Билет другого текста этого профиля.
  const wrong = await s.accept({ text, ticket: s.invariants.ticket(s.profileId, 'другое') })
  assert.equal(wrong.status, 400)
  assert.equal((await wrong.json()).code, 'no_ticket')

  // Билеты, созданные другим экземпляром сервиса (перезапуск), мертвы.
  const restarted = createInvariants({ sessions: s.sessions })
  const stale = await s.accept({ text, ticket: restarted.ticket(s.profileId, text) })
  assert.equal(stale.status, 400)
  assert.equal((await stale.json()).code, 'no_ticket')
  await s.close()
})

test('«доработать» без варианта и без конфликта — 502 draft_no_variants, ход оплачен', async () => {
  const s = await serveInvariants(['оценка: доработать\nзамечание: не годится'])
  const response = await s.draft('пиши покороче')
  const body = await response.json()

  assert.equal(response.status, 502)
  assert.equal(body.code, 'draft_no_variants')
  assert.equal(body.paid, true)
  assert.equal(s.fetchImpl.calls.length, 1, 'повторного вызова нет')
  await s.close()
})

test('конфликт без варианта доходит до страницы, а не превращается в отказ', async () => {
  const s = await serveInvariants(['оценка: доработать\nзамечание: противоречит\nконфликт: П1'])
  s.sessions.addInvariant({ profileId: s.profileId, text: 'Всегда приводи ссылки' })
  const response = await s.draft('никогда не приводи ссылки')
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.draft.conflict, 1)
  assert.deepEqual(body.draft.variants, [])
  await s.close()
})

test('черновик длиннее 1000 знаков и пустой — 400 без вызова', async () => {
  const s = await serveInvariants()
  const long = await s.draft('я'.repeat(1001))
  assert.equal(long.status, 400)
  const empty = await s.draft('   ')
  assert.equal(empty.status, 400)
  assert.equal(s.fetchImpl.calls.length, 0, 'вызова не было')
  await s.close()
})

test('одиннадцатый — 409 invariants_full, 201 знак — 400, дубль — 400', async () => {
  const s = await serveInvariants()
  const put = async (text) => {
    const ticket = s.invariants.ticket(s.profileId, text)
    return s.accept({ text, ticket })
  }
  for (let i = 1; i <= 10; i++) assert.equal((await put(`Правило ${i}`)).status, 200)

  const full = await put('Одиннадцатое')
  assert.equal(full.status, 409)
  assert.equal((await full.json()).code, 'invariants_full')
  // Ход черновика при полном профиле тоже не оплачивается.
  assert.equal((await s.draft('ещё одно')).status, 409)
  assert.equal(s.fetchImpl.calls.length, 0)

  const long = await put('я'.repeat(201))
  assert.equal(long.status, 400)
  assert.equal((await long.json()).code, 'bad_input')

  await s.del(1)
  const dupe = await put('пРаВиЛо 2')
  assert.equal(dupe.status, 400)
  assert.equal((await dupe.json()).code, 'duplicate')
  await s.close()
})

test('удаление по номеру: 200 и дыра в нумерации, чужой номер — 404', async () => {
  const s = await serveInvariants()
  for (const text of ['Первое', 'Второе']) {
    await s.accept({ text, ticket: s.invariants.ticket(s.profileId, text) })
  }
  assert.equal((await s.del(1)).status, 200)
  assert.equal((await s.del(1)).status, 404)

  const profile = (await (await s.get()).json()).profile
  assert.deepEqual(
    profile.invariants.map((i) => i.num),
    [2],
  )
  await s.close()
})
