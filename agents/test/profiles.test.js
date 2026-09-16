// День 11, фаза 3: профили, их диалоги, настройки и уборка
// (ADR 2026-09-15-2024, критерии 2, 3, 4 и 8).
// Требует Node 24 или флага --experimental-sqlite.

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { createNewsAnalyst } from '../src/agent.js'
import { createRuns } from '../src/runs.js'
import { createService } from '../src/service.js'
import { createSessions } from '../src/sessions.js'
import { ENV, fakeArchive, NEWS } from './fixtures.js'

const HOUR = 3600_000
const DAY = 24 * HOUR
/** Сессия дней 6–10: `profile_id` у неё NULL, и ни один профиль её не владеет. */
const LEGACY = '66666666-6666-4666-8666-666666666666'

/**
 * Хранилище на файле: к нему нужен второй доступ сырым SQL. Темы, факты тем
 * и правила пополняет вызов памяти (фаза 4б) — здесь они заводятся напрямую,
 * чтобы удаление профиля проверялось по всем девяти таблицам уже сейчас.
 */
function open(options = {}) {
  const file = join(mkdtempSync(join(tmpdir(), 'day11-')), 'sessions.db')
  // Числа — из окружения, как их проводит `server.js`: тест меряет те
  // потолки и сроки, которые получит прод, а не умолчания хранилища.
  const sessions = createSessions({
    file,
    ttlMs: ENV.SESSION_TTL_HOURS * HOUR,
    profileTtlMs: ENV.PROFILE_TTL_DAYS * DAY,
    profileCap: ENV.PROFILE_CAP,
    sessionCap: ENV.PROFILE_SESSION_CAP,
    log: () => {},
    ...options,
  })
  return { sessions, file }
}

const raw = (file) => new DatabaseSync(file)

/** Роутер, который падает при любом обращении: настройки его звать не должны. */
function boomRouter() {
  const calls = []
  const impl = async (url) => {
    calls.push(String(url))
    throw new Error('роутер вызван, хотя вызова быть не должно')
  }
  impl.calls = calls
  return impl
}

async function serve({ sessions, env = ENV }) {
  const runs = createRuns()
  const fetchImpl = boomRouter()
  const agent = createNewsAnalyst({
    agent: NEWS,
    archive: fakeArchive(),
    runs,
    sessions,
    env,
    fetchImpl,
    log: () => {},
  })
  const agents = new Map([[agent.id, agent]])
  const server = createServer(
    createService({ agents, archive: fakeArchive(), runs, sessions, env, log: () => {} }),
  )
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  // Упавшая проверка не доходит до `close()`, и открытый сервер держал бы
  // событийный цикл: прогон не падал бы, а висел — в CI это таймаут вместо
  // отчёта. `unref` снимает эту зависимость, запросы цикл держат сами.
  server.unref()
  const base = `http://127.0.0.1:${server.address().port}`
  const auth = { authorization: 'Bearer agent-key' }
  const call = (method, path, body) =>
    fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? auth : { ...auth, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  return {
    agent,
    fetchImpl,
    get: (path) => call('GET', path),
    rawGet: (path) => fetch(`${base}${path}`),
    post: (path, body) => call('POST', path, body ?? {}),
    put: (path, body) => call('PUT', path, body ?? {}),
    del: (path) => call('DELETE', path),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

const create = async (http, name) => (await (await http.post('/v1/profiles', { name })).json()).profile

// --- Критерий 2: профили и их потолок -----------------------------------

test('шестой профиль не создаётся: 409, и стереть чужой продукт не предлагает', async () => {
  const { sessions } = open()
  const http = await serve({ sessions })
  for (let i = 1; i <= 5; i++) {
    const response = await http.post('/v1/profiles', { name: `профиль ${i}` })
    assert.equal(response.status, 200)
  }
  const sixth = await http.post('/v1/profiles', { name: 'шестой' })
  assert.equal(sixth.status, 409)
  const body = await sixth.json()
  assert.equal(body.code, 'profiles_full')
  assert.doesNotMatch(body.message, /удал|сотр|осво/i, 'чужую память стирать не предлагаем')

  const list = await (await http.get('/v1/profiles')).json()
  assert.equal(list.profiles.length, 5, 'видны все живые профили')
  assert.equal(list.cap, 5)
  await http.close()
  sessions.close()
})

test('имя профиля чистится и проверяется на границе', async () => {
  const { sessions } = open()
  const http = await serve({ sessions })
  const spaced = await create(http, '  Аня   Петрова  ')
  assert.equal(spaced.name, 'Аня Петрова', 'пробелы схлопнуты, края обрезаны')
  assert.equal((await http.post('/v1/profiles', { name: '   ' })).status, 400)
  assert.equal((await http.post('/v1/profiles', { name: 'я'.repeat(41) })).status, 400)
  assert.equal((await http.post('/v1/profiles', { name: 42 })).status, 400)
  await http.close()
  sessions.close()
})

test('удаление профиля уносит всю его память и не трогает чужую', async () => {
  const { sessions, file } = open()
  const http = await serve({ sessions })
  const mine = await create(http, 'мой')
  const other = await create(http, 'чужой')

  // Два диалога удаляемого профиля и один у соседнего.
  const first = (await (await http.post(`/v1/profiles/${mine.id}/sessions`)).json()).sessionId
  const second = (await (await http.post(`/v1/profiles/${mine.id}/sessions`)).json()).sessionId
  const theirs = (await (await http.post(`/v1/profiles/${other.id}/sessions`)).json()).sessionId

  // Переписка, сводка, факты стратегии и цена — у всех трёх и у сессии дней 6–10.
  for (const sid of [first, second, theirs, LEGACY]) {
    const asked = sessions.append({ sessionId: sid, role: 'user', text: `вопрос ${sid}`, tokens: 10 })
    sessions.append({
      sessionId: sid,
      role: 'agent',
      text: 'ответ',
      tokens: 20,
      meta: { totalTokens: 100 },
    })
    sessions.saveSummary({
      sessionId: sid,
      text: 'пересказ',
      tokens: 5,
      sourceTokens: 30,
      throughId: asked,
      spentTokens: 7,
    })
    sessions.saveFacts({
      sessionId: sid,
      text: 'факт стратегии',
      tokens: 4,
      throughId: asked,
      limitTokens: 600,
      spentTokens: 3,
    })
  }

  // Слои профиля: правила, темы и факты тем — их пишет фаза 4б, здесь напрямую.
  const db = raw(file)
  for (const [profileId, sid] of [
    [mine.id, first],
    [other.id, theirs],
  ]) {
    db.prepare(
      'INSERT INTO personalization (profile_id, key, value, source_session_id, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(profileId, 'тон', 'отвечай коротко', sid, Date.now())
    const topic = db
      .prepare('INSERT INTO topics (profile_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(profileId, 'финтех', Date.now(), Date.now())
    db.prepare(
      'INSERT INTO topic_facts (topic_id, text, source_session_id, at) VALUES (?, ?, ?, ?)',
    ).run(Number(topic.lastInsertRowid), 'раунд D на $50M', sid, Date.now())
  }

  const before = {
    messages: db.prepare('SELECT count(*) AS n FROM messages').get().n,
    topics: db.prepare('SELECT count(*) AS n FROM topics').get().n,
  }
  assert.equal(before.topics, 2)

  const removed = await http.del(`/v1/profiles/${mine.id}`)
  assert.equal(removed.status, 200)

  // Ни одной строки удалённого профиля, его сессий и тем — во всех девяти таблицах.
  const gone = [
    ['profiles', 'SELECT count(*) AS n FROM profiles WHERE id = ?', mine.id],
    ['personalization', 'SELECT count(*) AS n FROM personalization WHERE profile_id = ?', mine.id],
    ['topics', 'SELECT count(*) AS n FROM topics WHERE profile_id = ?', mine.id],
    ['sessions', 'SELECT count(*) AS n FROM sessions WHERE profile_id = ?', mine.id],
  ]
  for (const [table, sql, id] of gone) {
    assert.equal(db.prepare(sql).get(id).n, 0, `${table}: строк удалённого профиля нет`)
  }
  for (const sid of [first, second]) {
    for (const table of ['messages', 'summaries', 'summary_costs', 'facts']) {
      assert.equal(
        db.prepare(`SELECT count(*) AS n FROM ${table} WHERE session_id = ?`).get(sid).n,
        0,
        `${table}: строк сессии удалённого профиля нет`,
      )
    }
  }
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM topic_facts').get().n,
    1,
    'факты темы удалённого профиля ушли, чужие остались',
  )

  // Чужое цело: соседний профиль и сессия дней 6–10 — байт в байт.
  assert.equal(db.prepare('SELECT count(*) AS n FROM profiles').get().n, 1)
  assert.equal(sessions.history(theirs).length, 2, 'переписка соседнего профиля цела')
  assert.equal(sessions.history(LEGACY).length, 2, 'переписка дней 6–10 цела')
  assert.ok(sessions.summary(LEGACY), 'сводка дней 6–10 цела')
  assert.ok(sessions.facts(LEGACY), 'факты стратегии дней 6–10 целы')
  assert.equal(sessions.totalTokens(LEGACY), 110)
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM messages').get().n,
    before.messages - 4,
    'ушли ровно четыре сообщения двух сессий удалённого профиля',
  )
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM sessions WHERE profile_id IS NULL').get().n,
    1,
    'сессия без профиля под оператор удаления не попадает',
  )

  assert.equal((await http.get(`/v1/profiles/${mine.id}`)).status, 404, 'профиля больше нет')
  db.close()
  await http.close()
  sessions.close()
})

// --- Критерий 3: сессии профиля -----------------------------------------

test('чужая сессия при чтении, удалении и переключении головы — 404', async () => {
  const { sessions } = open()
  const http = await serve({ sessions })
  const mine = await create(http, 'мой')
  const other = await create(http, 'чужой')
  const myId = (await (await http.post(`/v1/profiles/${mine.id}/sessions`)).json()).sessionId
  const theirId = (await (await http.post(`/v1/profiles/${other.id}/sessions`)).json()).sessionId

  sessions.append({ sessionId: myId, role: 'user', text: 'моё', tokens: 5 })
  // Чужая переписка в той же базе: номера сообщений сквозные (урок дня 10).
  const foreign = sessions.append({ sessionId: theirId, role: 'agent', text: 'чужое', tokens: 5 })
  const head = sessions.head(myId)

  assert.equal((await http.get(`/v1/sessions/${theirId}?profile=${mine.id}`)).status, 404)
  assert.equal((await http.del(`/v1/sessions/${theirId}?profile=${mine.id}`)).status, 404)
  assert.equal(sessions.history(theirId).length, 1, 'чужая переписка на месте')

  const foreignHead = await http.put(`/v1/sessions/${theirId}/head?profile=${mine.id}`, {
    messageId: foreign,
  })
  assert.equal(foreignHead.status, 404)

  // Своя сессия, но сообщение чужой: тот же отказ, голова не двигается.
  const foreignMessage = await http.put(`/v1/sessions/${myId}/head?profile=${mine.id}`, {
    messageId: foreign,
  })
  assert.equal(foreignMessage.status, 404)
  assert.equal((await foreignMessage.json()).code, 'unknown_message')
  assert.equal(sessions.head(myId), head, 'голова на месте')

  // Своя сессия со своим профилем читается.
  assert.equal((await http.get(`/v1/sessions/${myId}?profile=${mine.id}`)).status, 200)
  await http.close()
  sessions.close()
})

test('двадцать первый диалог профиля — 409, и на прямом создании тоже', async () => {
  const { sessions } = open()
  const http = await serve({ sessions })
  const profile = await create(http, 'плодовитый')
  for (let i = 1; i <= 20; i++) {
    assert.equal((await http.post(`/v1/profiles/${profile.id}/sessions`)).status, 200)
  }
  const extra = await http.post(`/v1/profiles/${profile.id}/sessions`)
  assert.equal(extra.status, 409)
  assert.equal((await extra.json()).code, 'sessions_full')

  // Тот же потолок на пути «первое сообщение без cookie сессии»: сессию там
  // создаёт то же `createSession` (ADR, п. 8.3).
  assert.deepEqual(sessions.createSession({ profileId: profile.id }), {
    ok: false,
    code: 'sessions_full',
  })
  assert.equal(sessions.sessionsOf(profile.id).length, 20, 'диалогов не прибавилось')
  await http.close()
  sessions.close()
})

test('выбор профиля с убранной по сроку сессией её не создаёт и срок не двигает', async () => {
  let t = 1_000_000_000
  const { sessions, file } = open({ now: () => t })
  const http = await serve({ sessions })
  const profile = await create(http, 'вернувшийся')
  const sid = (await (await http.post(`/v1/profiles/${profile.id}/sessions`)).json()).sessionId
  sessions.append({ sessionId: sid, role: 'user', text: 'вчерашний вопрос', tokens: 10 })

  t += 31 * HOUR // сессии 31 час, профилю — чуть больше суток
  assert.equal(sessions.sweep(), 1, 'диалог убран по сроку')
  // Срок читается из базы, а не из ответа: продление, сделанное после чтения
  // строки профиля, в ответе не видно — а память оно держит ещё месяц.
  const db = raw(file)
  const storedAt = () => db.prepare('SELECT last_seen_at AS at FROM profiles WHERE id = ?').get(profile.id).at
  const lastSeen = storedAt()

  const body = await (await http.get(`/v1/profiles/${profile.id}`)).json()
  assert.deepEqual(body.profile.sessions, [], 'живых диалогов нет')
  assert.equal(body.profile.lastSession, null, 'ставить cookie сессии нечем')
  assert.equal(storedAt(), lastSeen, 'чтение профиля не двигает хранимый last_seen_at')
  assert.equal(body.profile.lastSeenAt, lastSeen, 'и в ответе тот же срок, что в базе')
  assert.equal(sessions.stats().sessions, 0, 'выбор профиля сессию не создал')
  db.close()

  // Первое сообщение создаёт диалог профиля и двигает срок.
  const created = sessions.createSession({ profileId: profile.id })
  assert.equal(created.ok, true)
  assert.ok(sessions.profiles()[0].lastSeenAt > lastSeen, 'создание диалога продлевает профиль')
  await http.close()
  sessions.close()
})

test('создание диалога с темой ставит активную тему, чужая тема — 400', async () => {
  const { sessions, file } = open()
  const http = await serve({ sessions })
  const mine = await create(http, 'мой')
  const other = await create(http, 'чужой')
  const db = raw(file)
  const topic = (profileId) =>
    Number(
      db
        .prepare('INSERT INTO topics (profile_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(profileId, 'финтех', Date.now(), Date.now()).lastInsertRowid,
    )
  const own = topic(mine.id)
  const foreign = topic(other.id)

  const ok = await http.post(`/v1/profiles/${mine.id}/sessions`, { topicId: own })
  assert.equal(ok.status, 200)
  assert.equal(sessions.sessionsOf(mine.id)[0].topicId, own)
  assert.equal(sessions.sessionsOf(mine.id)[0].topicTitle, 'финтех')

  const alien = await http.post(`/v1/profiles/${mine.id}/sessions`, { topicId: foreign })
  assert.equal(alien.status, 400, 'тема чужого профиля активной не становится')
  assert.equal((await http.post(`/v1/profiles/${mine.id}/sessions`, { topicId: 10_000 })).status, 400)
  db.close()
  await http.close()
  sessions.close()
})

// --- Критерий 4: настройки ----------------------------------------------

test('настройки проверяются разборщиками запуска; чужой ключ и модель — 400', async () => {
  const { sessions } = open()
  const http = await serve({ sessions })
  const profile = await create(http, 'настройщик')
  const put = (settings) => http.put(`/v1/profiles/${profile.id}/settings`, settings)

  const good = await put({ strategy: 'window', window: 5, maxTokens: 2048, temperature: 0.3 })
  assert.equal(good.status, 200)
  const stored = await (await http.get(`/v1/profiles/${profile.id}`)).json()
  assert.deepEqual(stored.profile.settings, {
    strategy: 'window',
    window: 5,
    maxTokens: 2048,
    temperature: 0.3,
  })

  assert.equal((await put({ sphere: 'финтех' })).status, 400, 'сферы у агента дня 11 нет')
  assert.equal((await put({ perSource: 5 })).status, 400)
  assert.equal((await put({ articles: 10 })).status, 400)
  assert.equal((await put({ strategy: 'нет такой' })).status, 400)
  assert.equal((await put({ temperature: 0.35 })).status, 400)

  const overLimit = await put({ maxTokens: 2049 })
  assert.equal(overLimit.status, 400, 'потолок класса layered_dialogue — 2048')
  assert.match((await overLimit.json()).message, /от 1 до 2048/)

  // Модели Kimi день 11 принимает (ADR 2026-09-16-1038); несуществующая —
  // по-прежнему отказ на границе, и роутер не вызывается ни в том, ни в другом
  // случае: настройки пишутся без обращения к модели.
  const kimi = await put({ strategy: 'window', model: 'kimi-k3' })
  assert.equal(kimi.status, 200)
  assert.equal((await kimi.json()).settings.model, 'kimi-k3')

  const unknown = await put({ model: 'gpt-5' })
  assert.equal(unknown.status, 400)
  assert.match((await unknown.json()).message, /Неизвестная модель/)
  assert.deepEqual(http.fetchImpl.calls, [], 'к роутеру не ходили ни разу')

  // Отказ настроек прежние значения не портит.
  const after = await (await http.get(`/v1/profiles/${profile.id}`)).json()
  assert.equal(after.profile.settings.strategy, 'window')
  assert.equal(after.sessionCap, 20)
  await http.close()
  sessions.close()
})

test('запись настроек продлевает срок профиля, а отказ — нет', async () => {
  let t = 2_000_000_000
  const { sessions } = open({ now: () => t })
  const http = await serve({ sessions })
  const profile = await create(http, 'часовой')
  const created = sessions.profiles()[0].lastSeenAt

  t += 5 * DAY
  assert.equal((await http.put(`/v1/profiles/${profile.id}/settings`, { window: 3 })).status, 200)
  const moved = sessions.profiles()[0].lastSeenAt
  assert.equal(moved, created + 5 * DAY, 'запись настроек — действие в профиле')

  t += 1 * DAY
  assert.equal((await http.put(`/v1/profiles/${profile.id}/settings`, { window: 99 })).status, 400)
  assert.equal(sessions.profiles()[0].lastSeenAt, moved, 'отказ срок не двигает')
  await http.close()
  sessions.close()
})

// --- Критерий 8: уборка и сироты ----------------------------------------

test('профиль старше 30 дней уходит со всей памятью, соседний и дни 6–10 целы', async () => {
  let t = 3_000_000_000
  const { sessions, file } = open({ now: () => t })
  const http = await serve({ sessions })
  const old = await create(http, 'забытый')
  const db = raw(file)
  db.prepare(
    'INSERT INTO personalization (profile_id, key, value, source_session_id, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(old.id, 'тон', 'коротко', null, t)
  const topic = Number(
    db
      .prepare('INSERT INTO topics (profile_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(old.id, 'финтех', t, t).lastInsertRowid,
  )
  db.prepare('INSERT INTO topic_facts (topic_id, text, source_session_id, at) VALUES (?, ?, ?, ?)').run(
    topic,
    'факт',
    null,
    t,
  )
  sessions.append({ sessionId: LEGACY, role: 'user', text: 'день 7', tokens: 5 })
  // Диалог истёкшего профиля: он уйдёт внутри удаления профиля, а не по
  // сроку сессии, и обязан попасть в счёт убранного.
  assert.equal(sessions.createSession({ profileId: old.id }).ok, true)

  t += 10 * DAY
  const fresh = await create(http, 'живой')
  sessions.append({ sessionId: LEGACY, role: 'user', text: 'ещё день 7', tokens: 5 })

  t += 21 * DAY // забытому 31 день, живому 21
  assert.equal(
    sessions.sweep(),
    2,
    'в счёт убранного вошли и диалог истёкшего профиля, и сессия дней 6–10',
  )
  assert.deepEqual(
    sessions.profiles().map((p) => p.id),
    [fresh.id],
    'истёкший профиль убран, живой остался',
  )
  assert.equal(db.prepare('SELECT count(*) AS n FROM personalization').get().n, 0)
  assert.equal(db.prepare('SELECT count(*) AS n FROM topics').get().n, 0)
  assert.equal(db.prepare('SELECT count(*) AS n FROM topic_facts').get().n, 0)
  db.close()
  await http.close()
  sessions.close()
})

test('сироты новых таблиц убираются; сессия без профиля уходит целиком', () => {
  const { sessions, file } = open()
  const db = raw(file)
  const now = Date.now()
  // Строки, чей профиль или тема исчезли в обход `deleteProfile`.
  db.prepare(
    'INSERT INTO personalization (profile_id, key, value, source_session_id, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run('нет-такого', 'тон', 'коротко', null, now)
  db.prepare('INSERT INTO topics (profile_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
    'нет-такого',
    'бесхозная',
    now,
    now,
  )
  db.prepare('INSERT INTO topic_facts (topic_id, text, source_session_id, at) VALUES (?, ?, ?, ?)').run(
    777,
    'факт без темы',
    null,
    now,
  )
  const orphanSession = '55555555-5555-4555-8555-555555555555'
  db.prepare(
    'INSERT INTO sessions (id, created_at, last_seen_at, profile_id) VALUES (?, ?, ?, ?)',
  ).run(orphanSession, now, now, 'нет-такого')
  sessions.append({ sessionId: orphanSession, role: 'user', text: 'в сессии мёртвого профиля', tokens: 5 })
  sessions.append({ sessionId: LEGACY, role: 'user', text: 'день 7 жив', tokens: 5 })

  sessions.sweep()
  assert.equal(db.prepare('SELECT count(*) AS n FROM personalization').get().n, 0)
  assert.equal(db.prepare('SELECT count(*) AS n FROM topics').get().n, 0)
  assert.equal(db.prepare('SELECT count(*) AS n FROM topic_facts').get().n, 0)
  assert.equal(sessions.history(orphanSession).length, 0, 'сессия мёртвого профиля убрана целиком')
  assert.equal(sessions.history(LEGACY).length, 1, 'сессия дней 6–10 не тронута')
  db.close()
  sessions.close()
})

test('идентификатор профиля проверяется по форме; без ключа — 401 до всего', async () => {
  const { sessions } = open()
  const http = await serve({ sessions })
  assert.equal((await http.get('/v1/profiles/..')).status, 404)
  assert.equal((await http.get('/v1/profiles/00000000-0000-4000-8000-000000000000')).status, 404)
  assert.equal((await http.del('/v1/profiles/00000000-0000-4000-8000-000000000000')).status, 404)
  assert.equal((await http.post('/v1/profiles/../../etc/passwd')).status, 404)

  // Ключ сервиса — граница «день ↔ сервис»: без него ручки профилей молчат.
  const profile = await create(http, 'без ключа')
  assert.equal((await http.rawGet('/v1/profiles')).status, 401)
  assert.equal((await http.rawGet(`/v1/profiles/${profile.id}`)).status, 401)
  await http.close()
  sessions.close()
})
