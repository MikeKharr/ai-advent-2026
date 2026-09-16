// День 11, фаза 4б: темы, предложение новой темы и парковка фактов
// (ADR 2026-09-15-2024, критерии 7 и 8), плюс ручки слоёв у сервиса.
// Требует Node 24 или флага --experimental-sqlite.

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { createNewsAnalyst } from '../src/agent.js'
import { createLayeredAgent } from '../src/layered.js'
import { createRuns } from '../src/runs.js'
import { createService } from '../src/service.js'
import { createSessions } from '../src/sessions.js'
import { ENV, fakeArchive, LAYERED, NEWS } from './fixtures.js'

const HOUR = 3600_000
const DAY = 24 * HOUR

const ANSWER = {
  ok: true,
  text: 'Ответ агента.',
  provider: { id: 'anthropic-haiku', model: 'claude-haiku-4-5', tier: 'cloud-frontier' },
  truncated: false,
  durationMs: 100,
  usage: { inputTokens: 500, outputTokens: 40 },
}

const delta = (text) => ({
  ok: true,
  text,
  provider: { id: 'anthropic-haiku', model: 'claude-haiku-4-5', tier: 'cloud-frontier' },
  truncated: false,
  durationMs: 60,
  usage: { inputTokens: 300, outputTokens: 30 },
})

/** Роутер с крючками на обоих вызовах: в них живут гонки с удалением. */
function router({ answer = ANSWER, deltas = [], onAnswer = () => {}, onDelta = () => {} } = {}) {
  const calls = []
  let step = 0
  const impl = async (url, options = {}) => {
    if (String(url).includes('/v1/models'))
      return { ok: true, status: 200, json: async () => ({ providers: [] }) }
    const body = JSON.parse(options.body)
    calls.push(body)
    if (body.taskClass === 'summarize') {
      await onDelta()
      const next = deltas[Math.min(step++, deltas.length - 1)] ?? delta('тема: продолжить')
      return { ok: true, status: 200, json: async () => next }
    }
    await onAnswer()
    return { ok: true, status: 200, json: async () => answer }
  }
  impl.calls = calls
  impl.deltas = () => calls.filter((c) => c.taskClass === 'summarize')
  return impl
}

function open({ fetchImpl = router(), now } = {}) {
  const file = join(mkdtempSync(join(tmpdir(), 'day11-topics-')), 'sessions.db')
  const sessions = createSessions({
    file,
    ttlMs: ENV.SESSION_TTL_HOURS * HOUR,
    profileTtlMs: ENV.PROFILE_TTL_DAYS * DAY,
    profileCap: ENV.PROFILE_CAP,
    sessionCap: ENV.PROFILE_SESSION_CAP,
    log: () => {},
    ...(now ? { now } : {}),
  })
  const runs = createRuns()
  const agent = createLayeredAgent({
    agent: LAYERED,
    runs,
    sessions,
    env: ENV,
    fetchImpl,
    log: () => {},
  })
  const profile = sessions.createProfile({ name: 'Мика' }).profile
  const sid = sessions.createSession({ profileId: profile.id }).id
  const ask = async (body = {}) => {
    const parsed = agent.parseInput({
      profileId: profile.id,
      sessionId: sid,
      prompt: 'что нового',
      ...body,
    })
    if (!parsed.ok) return { refused: parsed.message }
    const run = runs.create({ agent, input: parsed.input })
    agent.hold(parsed.input.sessionId)
    await agent.execute(run)
    return { run, snapshot: runs.snapshot(run.id) }
  }
  return { file, sessions, runs, agent, fetchImpl, profile, sid, ask, db: () => new DatabaseSync(file) }
}

/** Сервис с обоими агентами: ручки слоёв и граница «день ↔ сервис». */
async function serve({ sessions, agent }) {
  const runs = createRuns()
  const news = createNewsAnalyst({
    agent: NEWS,
    archive: fakeArchive(),
    runs,
    sessions,
    env: ENV,
    fetchImpl: async () => {
      throw new Error('роутер вызван, хотя вызова быть не должно')
    },
    log: () => {},
  })
  const agents = new Map([
    [news.id, news],
    ...(agent ? [[agent.id, agent]] : []),
  ])
  const server = createServer(
    createService({ agents, archive: fakeArchive(), runs, sessions, env: ENV, log: () => {} }),
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
  return {
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body ?? {}),
    put: (path, body) => call('PUT', path, body ?? {}),
    del: (path) => call('DELETE', path),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** Тема профиля с активным состоянием: через предложение и ответ «открыть». */
function seedTopic({ sessions, sid, profileId, title = 'финтех' }) {
  const aliveId = sessions.append({ sessionId: sid, role: 'user', text: 'о чём мы', tokens: 5 })
  sessions.rememberLayers({
    sessionId: sid,
    profileId,
    aliveId,
    topic: { kind: 'propose', title },
    facts: [`первый факт темы ${title}`],
  })
  return sessions.resolveTopic({ sessionId: sid, profileId, decision: 'open' })
}

// --- Критерий 7: переход к существующей теме -----------------------------

test('«существующая id» меняет тему в том же запуске, вопроса в диалоге нет', async () => {
  // Сценарий пишется в ленту ответов уже после посева: идентификатор второй
  // темы известен только тогда.
  const script = []
  const { sessions, sid, profile, ask } = open({ fetchImpl: router({ deltas: script }) })
  const fintech = seedTopic({ sessions, sid, profileId: profile.id, title: 'финтех' })
  const climate = seedTopic({ sessions, sid, profileId: profile.id, title: 'климат' })
  sessions.resolveTopic({ sessionId: sid, profileId: profile.id, topicId: fintech.topicId })
  script.push(delta(`тема: существующая ${climate.topicId}\nфакт: ушёл в климат`))

  const { snapshot } = await ask({ prompt: 'а что по климату' })

  assert.equal(snapshot.status, 'succeeded')
  const state = sessions.sessionState(sid)
  assert.equal(state.topicId, climate.topicId, 'тема сменена в том же запуске')
  assert.equal(state.pending, null, 'вопроса человеку нет')
  const event = snapshot.events.find((e) => e.title.startsWith('Тема:'))
  assert.equal(event.stage, 'planning')
  assert.match(event.title, /перешёл сам/)
  assert.ok(
    sessions.topicFactsOf(climate.topicId, 10).some((f) => f.text === 'ушёл в климат'),
    'факты пары записаны в новую тему',
  )
  assert.equal(
    sessions.history(sid).some((m) => m.meta?.topicProposal),
    false,
    'карточки вопроса в диалоге нет',
  )
  sessions.close()
})

test('чужая и несуществующая тема читаются как «продолжить»', async () => {
  const mine = open({ fetchImpl: router({ deltas: [delta('тема: существующая 999\nфакт: остался тут')] }) })
  const active = seedTopic({ sessions: mine.sessions, sid: mine.sid, profileId: mine.profile.id })

  const { snapshot } = await mine.ask({ prompt: 'вопрос' })

  assert.equal(snapshot.status, 'succeeded')
  assert.equal(mine.sessions.sessionState(mine.sid).topicId, active.topicId, 'тема прежняя')
  assert.ok(
    mine.sessions.topicFactsOf(active.topicId, 10).some((f) => f.text === 'остался тут'),
    'факты ушли в активную тему',
  )
  mine.sessions.close()
})

// --- Критерий 7: предложение новой темы и парковка -----------------------

test('«предложить новую»: предложение записано, карточка в логе, факты нигде', async () => {
  const { sessions, sid, profile, ask } = open({
    fetchImpl: router({
      deltas: [delta('тема: предложить новую: Климатические стартапы Индии\nфакт: Ather Energy — раунд D')],
    }),
  })
  seedTopic({ sessions, sid, profileId: profile.id })

  const { snapshot } = await ask({ prompt: 'а что по климату' })

  const state = sessions.sessionState(sid)
  assert.equal(state.pending.title, 'Климатические стартапы Индии')
  assert.deepEqual(state.pending.facts, ['Ather Energy — раунд D'], 'факты припаркованы')
  const card = sessions.history(sid).at(-1)
  assert.equal(card.role, 'agent')
  assert.equal(card.meta.topicProposal.title, 'Климатические стартапы Индии')
  assert.match(card.text, /Открыть новую тему или продолжить в «финтех»\?/)
  assert.equal(sessions.topicsOf(profile.id).length, 1, 'новой темы пока нет')
  const event = snapshot.events.find((e) => e.title.startsWith('Предлагаю тему'))
  assert.match(event.detail, /1 фактов ждут вашего ответа/)
  sessions.close()
})

test('при ожидающем предложении переходов нет, а «открыть» уносит и припаркованное', async () => {
  const { sessions, sid, profile, ask } = open({
    fetchImpl: router({
      deltas: [
        delta('тема: предложить новую: Климат\nфакт: первый припаркованный'),
        delta('тема: существующая 1\nфакт: второй припаркованный'),
        delta('тема: открыть\nфакт: третий факт'),
      ],
    }),
  })
  const active = seedTopic({ sessions, sid, profileId: profile.id })

  await ask({ prompt: 'раз' })
  const second = await ask({ prompt: 'два' })

  const waiting = sessions.sessionState(sid)
  assert.equal(waiting.topicId, active.topicId, 'при ожидающем предложении тема не меняется')
  assert.equal(waiting.pending.facts.length, 2, 'факты пары добавлены в парковку')
  const event = second.snapshot.events.find((e) => e.title === 'Тема не сменена: ждёт вашего ответа')
  assert.equal(event.stage, 'planning')

  // Человек ответил репликой: следующий вызов вернул «открыть».
  await ask({ prompt: 'да, открывай' })
  const after = sessions.sessionState(sid)
  const opened = sessions.topicsOf(profile.id).find((t) => t.title === 'Климат')
  assert.equal(after.topicId, opened.id, 'тема открыта и стала активной')
  assert.equal(after.pending, null, 'парковка разобрана')
  const texts = sessions.topicFactsOf(opened.id, 10).map((f) => f.text)
  assert.deepEqual(texts, ['первый припаркованный', 'второй припаркованный', 'третий факт'])
  assert.equal(sessions.topicFactsOf(active.topicId, 10).length, 1, 'в прежней теме ничего не осело')
  sessions.close()
})

test('кнопка «открыть» и «продолжить» — та же операция без вызова модели', async () => {
  const opened = open({
    fetchImpl: router({ deltas: [delta('тема: предложить новую: Климат\nфакт: припаркованный')] }),
  })
  const active = seedTopic({ sessions: opened.sessions, sid: opened.sid, profileId: opened.profile.id })
  await opened.ask({ prompt: 'раз' })
  const before = opened.fetchImpl.calls.length

  const result = opened.sessions.resolveTopic({
    sessionId: opened.sid,
    profileId: opened.profile.id,
    decision: 'open',
  })
  assert.equal(result.ok, true)
  assert.equal(result.factsWritten, 1)
  assert.equal(opened.fetchImpl.calls.length, before, 'ответ кнопкой не стоит ни одного вызова')
  assert.equal(opened.sessions.sessionState(opened.sid).topicId, result.topicId)
  opened.sessions.close()

  // «Продолжить»: припаркованное уходит в активную тему.
  const kept = open({
    fetchImpl: router({ deltas: [delta('тема: предложить новую: Климат\nфакт: припаркованный')] }),
  })
  const keptTopic = seedTopic({ sessions: kept.sessions, sid: kept.sid, profileId: kept.profile.id })
  await kept.ask({ prompt: 'раз' })
  const stay = kept.sessions.resolveTopic({
    sessionId: kept.sid,
    profileId: kept.profile.id,
    decision: 'continue',
  })
  assert.equal(stay.topicId, keptTopic.topicId)
  assert.ok(
    kept.sessions.topicFactsOf(keptTopic.topicId, 10).some((f) => f.text === 'припаркованный'),
    'припаркованное ушло в активную тему',
  )
  assert.equal(kept.sessions.topicsOf(kept.profile.id).length, 1, 'новой темы не появилось')
  kept.sessions.close()
})

test('без активной темы «продолжить» факты не пишет и говорит об этом', async () => {
  const { sessions, sid, profile, ask } = open({
    fetchImpl: router({ deltas: [delta('тема: продолжить\nфакт: некуда записать')] }),
  })

  const { snapshot } = await ask({ prompt: 'вопрос' })

  assert.deepEqual(sessions.topicsOf(profile.id), [], 'тем не появилось')
  const warning = snapshot.events.find((e) => e.title === 'Тема не выбрана — факты не записаны')
  assert.equal(warning.level, 'warn')
  assert.equal(warning.data.dropped, 1)
  sessions.close()
})

test('название существующей темы — переход к ней без вопроса', async () => {
  const { sessions, sid, profile, ask } = open({
    fetchImpl: router({ deltas: [delta('тема: предложить новую: ФИНТЕХ\nфакт: тот же предмет')] }),
  })
  const active = seedTopic({ sessions, sid, profileId: profile.id, title: 'финтех' })
  const other = seedTopic({ sessions, sid, profileId: profile.id, title: 'климат' })
  sessions.resolveTopic({ sessionId: sid, profileId: profile.id, topicId: other.topicId })

  await ask({ prompt: 'вопрос' })

  assert.equal(sessions.sessionState(sid).pending, null, 'вопроса нет')
  assert.equal(sessions.sessionState(sid).topicId, active.topicId, 'перешли к существующей теме')
  assert.equal(sessions.topicsOf(profile.id).length, 2, 'дубля темы не завелось')
  sessions.close()
})

test('без ответа через 30 часов парковка уходит вместе с диалогом, темы целы', async () => {
  let t = 2_000_000_000_000
  const { sessions, sid, profile, ask } = open({
    fetchImpl: router({ deltas: [delta('тема: предложить новую: Климат\nфакт: припаркованный')] }),
    now: () => t,
  })
  const active = seedTopic({ sessions, sid, profileId: profile.id })
  await ask({ prompt: 'раз' })
  assert.ok(sessions.sessionState(sid).pending)

  t += 31 * HOUR
  sessions.sweep()

  assert.equal(sessions.sessionState(sid), null, 'диалог убран по сроку')
  assert.equal(sessions.topicsOf(profile.id).length, 1, 'тема профиля пережила диалог')
  assert.equal(sessions.topicFactsOf(active.topicId, 10).length, 1, 'факты темы целы')
  sessions.close()
})

// --- Критерий 7: потолки слоёв -------------------------------------------

test('31-я тема, 61-й факт и 41-е правило не записываются, существующее имя обновляется', async () => {
  const { sessions, sid, profile, file } = open()
  const db = new DatabaseSync(file)
  const now = Date.now()
  for (let i = 1; i <= 30; i++) {
    db.prepare(
      'INSERT INTO topics (profile_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run(profile.id, `тема ${i}`, now, now + i)
  }
  for (let i = 1; i <= 40; i++) {
    db.prepare(
      'INSERT INTO personalization (profile_id, key, value, source_session_id, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(profile.id, `правило ${i}`, 'значение', null, now + i)
  }
  const aliveId = sessions.append({ sessionId: sid, role: 'user', text: 'вопрос', tokens: 5 })

  // 31-я тема: предложение принято кнопкой, но места нет.
  sessions.rememberLayers({
    sessionId: sid,
    profileId: profile.id,
    aliveId,
    topic: { kind: 'propose', title: 'тридцать первая' },
    facts: ['факт'],
  })
  const resolved = sessions.resolveTopic({ sessionId: sid, profileId: profile.id, decision: 'open' })
  assert.equal(db.prepare('SELECT count(*) AS n FROM topics').get().n, 30, '31-я тема не записана')
  assert.deepEqual(
    resolved.warnings.map((w) => w.code),
    ['topics_full', 'no_topic'],
    'потолок назван, факты не записаны',
  )

  // 61-й факт темы.
  const topicId = db.prepare('SELECT id FROM topics LIMIT 1').get().id
  for (let i = 1; i <= 60; i++) {
    db.prepare('INSERT INTO topic_facts (topic_id, text, source_session_id, at) VALUES (?, ?, ?, ?)').run(
      topicId,
      `факт ${i}`,
      null,
      now,
    )
  }
  sessions.resolveTopic({ sessionId: sid, profileId: profile.id, topicId })
  const report = sessions.rememberLayers({
    sessionId: sid,
    profileId: profile.id,
    aliveId,
    facts: ['шестьдесят первый'],
    rules: [
      { key: 'правило 1', value: 'обновлённое значение' },
      { key: 'сорок первое', value: 'новое имя' },
    ],
  })
  assert.equal(report.factsWritten, 0)
  assert.ok(report.warnings.some((w) => w.code === 'topic_facts_full' && w.cap === 60))
  assert.ok(report.warnings.some((w) => w.code === 'rules_full' && w.cap === 40))
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM topic_facts WHERE topic_id = ?').get(topicId).n,
    60,
  )
  assert.equal(db.prepare('SELECT count(*) AS n FROM personalization').get().n, 40)
  assert.equal(
    db.prepare('SELECT value FROM personalization WHERE key = ?').get('правило 1').value,
    'обновлённое значение',
    'существующее имя обновлено, а не добавлено',
  )
  db.close()
  sessions.close()
})

// --- Критерий 8: гонки с удалением ---------------------------------------

test('DELETE профиля во время пополнения: ничего не появляется, цена никого не воскрешает', async () => {
  let removeNow = () => {}
  const harness = open({
    fetchImpl: router({
      deltas: [delta('тема: предложить новую: Климат\nфакт: припаркованный\nправило: тон — коротко')],
      onDelta: () => removeNow(),
    }),
  })
  removeNow = () => harness.sessions.deleteProfile(harness.profile.id)

  const { snapshot } = await harness.ask({ prompt: 'вопрос' })

  assert.equal(snapshot.status, 'succeeded', 'запуск отвечает: ответ уже получен')
  const db = harness.db()
  for (const table of ['topics', 'topic_facts', 'personalization', 'profiles']) {
    assert.equal(
      db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,
      0,
      `${table}: после удаления профиля строк не появилось`,
    )
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0, 'сессия не воскресла')
  assert.equal(db.prepare('SELECT count(*) AS n FROM summary_costs').get().n, 0, 'цена не воскресила строк')
  const warning = snapshot.events.find((e) => e.title === 'Память профиля не пополнена')
  assert.match(warning.detail, /удалили во время вызова/)
  db.close()
  harness.sessions.close()
})

test('удаление профиля во время запуска — 409, а не воскресшая сессия', async () => {
  let release = () => {}
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const harness = open({ fetchImpl: router({ onAnswer: () => gate }) })
  const http = await serve({ sessions: harness.sessions, agent: harness.agent })

  const running = harness.ask({ prompt: 'вопрос' })
  // Запуск держит замок: удаление профиля в этот момент отклоняется.
  await new Promise((resolve) => setImmediate(resolve))
  const refused = await http.del(`/v1/profiles/${harness.profile.id}`)
  assert.equal(refused.status, 409)
  assert.equal((await refused.json()).code, 'busy')

  release()
  await running
  const allowed = await http.del(`/v1/profiles/${harness.profile.id}`)
  assert.equal(allowed.status, 200, 'после ответа удаление проходит')
  const db = harness.db()
  assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0)
  assert.equal(db.prepare('SELECT count(*) AS n FROM messages').get().n, 0, 'ни следа переписки')
  db.close()
  await http.close()
  harness.sessions.close()
})

// --- Ручки слоёв у сервиса ----------------------------------------------

test('GET сессии отдаёт профиль, активную тему и ожидающее предложение', async () => {
  const harness = open({
    fetchImpl: router({ deltas: [delta('тема: предложить новую: Климат\nфакт: припаркованный')] }),
  })
  seedTopic({ sessions: harness.sessions, sid: harness.sid, profileId: harness.profile.id })
  await harness.ask({ prompt: 'вопрос' })
  const http = await serve({ sessions: harness.sessions, agent: harness.agent })

  const body = await (
    await http.get(`/v1/sessions/${harness.sid}?profile=${harness.profile.id}`)
  ).json()

  assert.equal(body.profileId, harness.profile.id)
  assert.equal(body.topic.title, 'финтех')
  assert.deepEqual(body.pendingTopic, { title: 'Климат', facts: 1 })
  await http.close()
  harness.sessions.close()
})

test('POST …/topic: чужая сессия — 404, во время запуска — 409, без предложения — 409', async () => {
  let release = () => {}
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const harness = open({ fetchImpl: router({ onAnswer: () => gate }) })
  const stranger = harness.sessions.createProfile({ name: 'чужой' }).profile
  const http = await serve({ sessions: harness.sessions, agent: harness.agent })
  const path = `/v1/sessions/${harness.sid}/topic`

  const foreign = await http.post(`${path}?profile=${stranger.id}`, { decision: 'open' })
  assert.equal(foreign.status, 404)
  assert.equal((await foreign.json()).code, 'unknown_session')

  const running = harness.ask({ prompt: 'вопрос' })
  await new Promise((resolve) => setImmediate(resolve))
  const busy = await http.post(`${path}?profile=${harness.profile.id}`, { decision: 'open' })
  assert.equal(busy.status, 409)
  assert.equal((await busy.json()).code, 'busy')
  release()
  await running

  const nothing = await http.post(`${path}?profile=${harness.profile.id}`, { decision: 'open' })
  assert.equal(nothing.status, 409)
  assert.equal((await nothing.json()).code, 'no_pending')

  const bad = await http.post(`${path}?profile=${harness.profile.id}`, { topicId: 10_000 })
  assert.equal(bad.status, 400, 'чужая тема активной не становится')
  await http.close()
  harness.sessions.close()
})

test('ручной выбор темы разбирает висящий вопрос: парковка уходит в выбранную тему', async () => {
  const { sessions, sid, profile, ask } = open({
    fetchImpl: router({ deltas: [delta('тема: предложить новую: Климат\nфакт: припаркованный')] }),
  })
  const fintech = seedTopic({ sessions, sid, profileId: profile.id })
  const robotics = seedTopic({ sessions, sid, profileId: profile.id, title: 'роботы' })
  sessions.resolveTopic({ sessionId: sid, profileId: profile.id, topicId: fintech.topicId })
  await ask({ prompt: 'раз' })
  assert.ok(sessions.sessionState(sid).pending, 'вопрос висит')

  const manual = sessions.resolveTopic({
    sessionId: sid,
    profileId: profile.id,
    topicId: robotics.topicId,
  })

  assert.equal(manual.ok, true)
  assert.equal(manual.factsWritten, 1)
  assert.equal(sessions.sessionState(sid).pending, null, 'вопрос снят выбором человека')
  assert.equal(sessions.sessionState(sid).topicId, robotics.topicId)
  assert.ok(
    sessions.topicFactsOf(robotics.topicId, 10).some((f) => f.text === 'припаркованный'),
    'припаркованное ушло в выбранную человеком тему, а не повисло',
  )
  sessions.close()
})

test('ручная смена темы и факты темы для монитора', async () => {
  const harness = open()
  const first = seedTopic({ sessions: harness.sessions, sid: harness.sid, profileId: harness.profile.id })
  const second = seedTopic({
    sessions: harness.sessions,
    sid: harness.sid,
    profileId: harness.profile.id,
    title: 'климат',
  })
  const http = await serve({ sessions: harness.sessions, agent: harness.agent })

  const switched = await http.post(
    `/v1/sessions/${harness.sid}/topic?profile=${harness.profile.id}`,
    { topicId: first.topicId },
  )
  assert.equal(switched.status, 200)
  assert.equal((await switched.json()).topic.title, 'финтех')
  assert.equal(harness.sessions.sessionState(harness.sid).topicId, first.topicId)

  const cleared = await http.post(
    `/v1/sessions/${harness.sid}/topic?profile=${harness.profile.id}`,
    { topicId: null },
  )
  assert.equal(cleared.status, 200, '«без темы» — законный выбор человека')
  assert.equal(harness.sessions.sessionState(harness.sid).topicId, null)

  const facts = await (
    await http.get(`/v1/profiles/${harness.profile.id}/topics/${second.topicId}`)
  ).json()
  assert.equal(facts.topic.title, 'климат')
  assert.equal(facts.topic.facts[0].text, 'первый факт темы климат')
  assert.match(facts.topic.facts[0].at, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal((await http.get(`/v1/profiles/${harness.profile.id}/topics/99999`)).status, 404)
  await http.close()
  harness.sessions.close()
})

test('ручка архива у агента без инструментов — 404; настройки берут умолчания его реестра', async () => {
  const harness = open()
  const http = await serve({ sessions: harness.sessions, agent: harness.agent })

  assert.equal((await http.get('/v1/agents/layered-agent/tools/archive')).status, 404)
  assert.equal((await http.get('/v1/agents/news-analyst/tools/archive')).status, 200)

  // Порог сводки сверяется с размером контекста из реестра агента дня 11,
  // а не с числом, зашитым в разборщик настроек (находка ревьюера, PR #151).
  const put = (settings) => http.put(`/v1/profiles/${harness.profile.id}/settings`, settings)
  assert.equal((await put({ summarizeAt: 3000 })).status, 200, 'порог по контексту реестра')
  const over = await put({ summarizeAt: 3001 })
  assert.equal(over.status, 400)
  assert.match((await over.json()).message, /не больше размера контекста \(3000\)/)

  const described = await (await http.get('/v1/agents')).json()
  const layered = described.agents.find((a) => a.id === 'layered-agent')
  assert.equal(layered.limits.maxTokens, 2048, 'окно настроек обещает потолок класса')
  await http.close()
  harness.sessions.close()
})
