// Ключевой профиль: чтение и создание по именному ключу
// (ADR 2026-10-07-1349, п. 2 и п. 7, Б8).
// Требует Node 24 или флага --experimental-sqlite.
//
// Что держат тесты ниже:
//   — ключевого профиля нет в публичном списке и нет у держателя ЧУЖОГО имени;
//   — каждый путь ветви профилей без ключа отвечает БАЙТ В БАЙТ как у
//     несуществующего профиля, а с ключом того же имени — отдаёт;
//   — заголовок, не совпавший ни с одним именем, — 403 на создании, на
//     чтениях и на запуске, и профиля в базе после него нет (Б8);
//   — действительный ключ другого имени — 404, а не 403: 403 говорит только
//     о самом заголовке и ничего — о профилях;
//   — пустая MODEL_KEYS: ключевые профили не создаются вовсе.

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { createLayeredAgent } from '../src/layered.js'
import { createModelKeys } from '../src/model-keys.js'
import { createRuns } from '../src/runs.js'
import { createService } from '../src/service.js'
import { createSessions } from '../src/sessions.js'
import { ENV, fakeArchive, LAYERED } from './fixtures.js'

const HOUR = 3600_000
const DAY = 24 * HOUR

const MIKE = 'M'.repeat(32)
const GUEST = 'G'.repeat(32)
/**
 * Значение, не совпадающее ни с одним именем. Только ASCII: значение ключа —
 * base64url, а заголовок HTTP не принимает ничего вне ByteString. Кириллица
 * здесь падала бы на `fetch`, то есть проверяла бы форму теста, а не сервис.
 */
const WRONG = 'W'.repeat(32)
const ENTRIES = [
  { name: 'mike', value: MIKE },
  { name: 'guest1', value: GUEST },
]

function open() {
  const file = join(mkdtempSync(join(tmpdir(), 'keyed-')), 'sessions.db')
  const sessions = createSessions({
    file,
    ttlMs: ENV.SESSION_TTL_HOURS * HOUR,
    profileTtlMs: ENV.PROFILE_TTL_DAYS * DAY,
    profileCap: ENV.PROFILE_CAP,
    sessionCap: ENV.PROFILE_SESSION_CAP,
    log: () => {},
  })
  return { sessions, file }
}

/** Роутер, который падает при любом обращении: чтения его звать не должны. */
function boomRouter() {
  const calls = []
  const impl = async (url) => {
    calls.push(String(url))
    throw new Error('роутер вызван, хотя вызова быть не должно')
  }
  impl.calls = calls
  return impl
}

async function serve({ sessions, entries = ENTRIES, env = ENV }) {
  const runs = createRuns()
  const fetchImpl = boomRouter()
  const agent = createLayeredAgent({
    agent: LAYERED,
    runs,
    sessions,
    env,
    fetchImpl,
    log: () => {},
  })
  const agents = new Map([[agent.id, agent]])
  const modelKeys = createModelKeys({ entries })
  const server = createServer(
    createService({
      agents,
      archive: fakeArchive(),
      runs,
      sessions,
      modelKeys,
      env,
      log: () => {},
    }),
  )
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  server.unref()
  const base = `http://127.0.0.1:${server.address().port}`

  /** @param key значение `x-model-key` или undefined — заголовка нет вовсе. */
  const call = (method, path, { key, body } = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: 'Bearer agent-key',
        ...(key === undefined ? {} : { 'x-model-key': key }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  return {
    fetchImpl,
    modelKeys,
    get: (path, key) => call('GET', path, { key }),
    post: (path, body, key) => call('POST', path, { body: body ?? {}, key }),
    put: (path, body, key) => call('PUT', path, { body: body ?? {}, key }),
    del: (path, key) => call('DELETE', path, { key }),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** Создать профиль: с ключом — ключевой, без — открытый. */
const create = async (http, name, key) =>
  (await (await http.post('/v1/profiles', { name }, key)).json()).profile

/** Ответ целиком: статус и текст тела — для сверки «байт в байт». */
const shape = async (response) => ({ status: response.status, body: await response.text() })

// --- Создание --------------------------------------------------------------

test('ключ создаёт ключевой профиль, его отсутствие — открытый', async () => {
  const { sessions, file } = open()
  const http = await serve({ sessions })

  const keyed = await create(http, 'ключевой', MIKE)
  const open_ = await create(http, 'открытый')
  assert.equal(keyed.keyName, 'mike', 'имя ключа стоит у профиля')
  assert.equal(open_.keyName, null, 'открытый профиль ключа не носит')

  // Столбец в базе, а не только в ответе: смешанных профилей не бывает.
  const db = new DatabaseSync(file)
  // `{ ...row }`: node:sqlite отдаёт строки с null-прототипом, и deepEqual
  // сравнивал бы прототипы, а не поля.
  const rows = db
    .prepare('SELECT name, key_name AS k FROM profiles ORDER BY name')
    .all()
    .map((row) => ({ ...row }))
  assert.deepEqual(rows, [
    { name: 'ключевой', k: 'mike' },
    { name: 'открытый', k: null },
  ])
  db.close()
  await http.close()
  sessions.close()
})

test('заголовок не из MODEL_KEYS: 403 bad_model_key, и профиля в базе нет (Б8)', async () => {
  const { sessions, file } = open()
  const http = await serve({ sessions })

  const response = await http.post('/v1/profiles', { name: 'опечатка' }, WRONG)
  assert.equal(response.status, 403)
  const body = await response.json()
  assert.equal(body.code, 'bad_model_key')
  // Ни предъявленного значения, ни настоящего, ни имён — в отказе нет.
  const dump = JSON.stringify(body)
  assert.equal(dump.includes(WRONG), false)
  assert.equal(dump.includes(MIKE), false)
  assert.equal(dump.includes('mike'), false)

  // Главное утверждение Б8: ОТКРЫТЫЙ профиль на опечатке в ключе не родился.
  const db = new DatabaseSync(file)
  assert.equal(db.prepare('SELECT count(*) AS n FROM profiles').get().n, 0, 'профиля нет вовсе')
  db.close()
  await http.close()
  sessions.close()
})

test('пустая MODEL_KEYS: ключевые профили не создаются, любой заголовок — отказ', async () => {
  const { sessions, file } = open()
  const http = await serve({ sessions, entries: [] })

  for (const key of ['', MIKE, WRONG]) {
    assert.equal((await http.post('/v1/profiles', { name: 'п' }, key)).status, 403, JSON.stringify(key))
  }
  // Без заголовка день 11 работает как до ADR — контрольная ветвь.
  assert.equal((await http.post('/v1/profiles', { name: 'открытый' })).status, 200)

  const db = new DatabaseSync(file)
  const rows = db.prepare('SELECT key_name AS k FROM profiles').all().map((row) => ({ ...row }))
  assert.deepEqual(rows, [{ k: null }], 'ни одного профиля с именем ключа')
  db.close()
  await http.close()
  sessions.close()
})

// --- Публичный список ------------------------------------------------------

test('ключевого профиля нет в списке без ключа и с ключом другого имени', async () => {
  const { sessions } = open()
  const http = await serve({ sessions })
  const keyed = await create(http, 'ключевой', MIKE)
  await create(http, 'открытый')

  const ids = async (key) =>
    (await (await http.get('/v1/profiles', key)).json()).profiles.map((p) => p.id)

  assert.equal((await ids(undefined)).includes(keyed.id), false, 'без ключа — нет')
  assert.equal((await ids(GUEST)).includes(keyed.id), false, 'с ключом другого имени — нет')
  assert.equal((await ids(MIKE)).includes(keyed.id), true, 'со своим ключом — есть')
  // Контрольная ветвь: открытый профиль виден во всех трёх случаях, иначе
  // зелёный результат удовлетворяла бы гипотеза «список всегда пуст».
  for (const key of [undefined, GUEST, MIKE]) {
    assert.equal((await ids(key)).length >= 1, true)
  }
  await http.close()
  sessions.close()
})

// --- Чтение: каждый путь ---------------------------------------------------

test('каждый путь профиля без ключа отвечает как у несуществующего, с ключом — отдаёт', async () => {
  const { sessions } = open()
  const http = await serve({ sessions })
  const keyed = await create(http, 'ключевой', MIKE)
  // Диалог и тема внутри ключевого профиля — чтобы пути отдавали не пустоту.
  const made = await (await http.post(`/v1/profiles/${keyed.id}/sessions`, {}, MIKE)).json()
  assert.equal(made.ok, true)

  // Профиль, которого нет вовсе: эталон ответа. Сравнение идёт с ним, а не с
  // ожидаемой строкой, — тогда «байт в байт» остаётся правдой и после правки
  // текста отказа.
  const GHOST = '99999999-9999-4999-8999-999999999999'

  const paths = [
    '',
    '/settings',
    '/sessions',
    '/topics/1',
    '/invariants',
    '/prompts/answer',
  ]
  for (const tail of paths) {
    const ghost = await shape(await http.get(`/v1/profiles/${GHOST}${tail}`))
    const hidden = await shape(await http.get(`/v1/profiles/${keyed.id}${tail}`))
    const alien = await shape(await http.get(`/v1/profiles/${keyed.id}${tail}`, GUEST))
    assert.equal(hidden.status, 404, `${tail || '/'}: без ключа 404`)
    assert.deepEqual(hidden, ghost, `${tail || '/'}: без ключа — байт в байт как несуществующий`)
    assert.deepEqual(alien, ghost, `${tail || '/'}: чужое имя ключа — то же самое`)
  }

  // Со своим ключом те пути, что отвечают на GET, отдают профиль.
  const mine = await http.get(`/v1/profiles/${keyed.id}`, MIKE)
  assert.equal(mine.status, 200)
  assert.equal((await mine.json()).profile.name, 'ключевой')
  const list = await http.get(`/v1/profiles/${keyed.id}/sessions`, MIKE)
  assert.equal(list.status, 200)
  assert.equal((await list.json()).sessions.length, 1)

  // Записи — тоже закрыты: настройки и удаление без ключа отвечают как у
  // несуществующего, и ничего не меняют.
  const put = await http.put(`/v1/profiles/${keyed.id}/settings`, { maxTokens: 777 })
  assert.deepEqual(await shape(put), await shape(await http.put(`/v1/profiles/${GHOST}/settings`, { maxTokens: 777 })))
  const still = await (await http.get(`/v1/profiles/${keyed.id}`, MIKE)).json()
  assert.equal(still.profile.settings.maxTokens, undefined, 'настройки не изменились')

  const del = await http.del(`/v1/profiles/${keyed.id}`)
  assert.equal(del.status, 404)
  assert.equal((await http.get(`/v1/profiles/${keyed.id}`, MIKE)).status, 200, 'профиль цел')

  // Роутера в этом тесте не звали ни разу: чтения модель не зовут.
  assert.deepEqual(http.fetchImpl.calls, [])
  await http.close()
  sessions.close()
})

test('диалог ключевого профиля закрыт тем же ключом', async () => {
  const { sessions } = open()
  const http = await serve({ sessions })
  const keyed = await create(http, 'ключевой', MIKE)
  const { sessionId } = await (
    await http.post(`/v1/profiles/${keyed.id}/sessions`, {}, MIKE)
  ).json()

  const GHOST_SID = '88888888-8888-4888-8888-888888888888'

  // Сравнение — с несуществующим диалогом НА ТОМ ЖЕ пути, а не с заранее
  // выписанным телом: «неотличимо от несуществующего» есть утверждение о двух
  // ответах, и правка текста отказа не должна делать проверку ложно зелёной.
  //
  // Путь с `?profile=` отвечает 404 (чужой диалог профиля), путь БЕЗ
  // параметра — 200 с пустой перепиской: так день 6–10 отвечает на любой
  // неизвестный ему номер. Важно здесь не число, а совпадение с ответом на
  // несуществующий диалог — то есть что переписки в нём нет.
  for (const [what, hidden, ghost] of [
    [
      'без ключа',
      await http.get(`/v1/sessions/${sessionId}?profile=${keyed.id}`),
      await http.get(`/v1/sessions/${GHOST_SID}?profile=${keyed.id}`),
    ],
    [
      'чужое имя ключа',
      await http.get(`/v1/sessions/${sessionId}?profile=${keyed.id}`, GUEST),
      await http.get(`/v1/sessions/${GHOST_SID}?profile=${keyed.id}`, GUEST),
    ],
    [
      'без параметра profile — путь дней 6–10 не лазейка',
      await http.get(`/v1/sessions/${sessionId}`),
      await http.get(`/v1/sessions/${GHOST_SID}`),
    ],
  ]) {
    const seen = await shape(hidden)
    assert.deepEqual(seen, await shape(ghost), `${what}: как несуществующий диалог`)
    assert.equal(seen.body.includes('"text"'), false, `${what}: ни одной реплики в ответе`)
  }
  // Со своим ключом — отдаёт.
  assert.equal((await http.get(`/v1/sessions/${sessionId}?profile=${keyed.id}`, MIKE)).status, 200)

  // Удаление переписки и смена темы закрыты тем же предикатом.
  assert.equal((await http.del(`/v1/sessions/${sessionId}?profile=${keyed.id}`)).status, 404)
  assert.equal(
    (await http.post(`/v1/sessions/${sessionId}/topic?profile=${keyed.id}`, { topicId: null })).status,
    404,
  )
  assert.equal(
    (await http.put(`/v1/sessions/${sessionId}/head?profile=${keyed.id}`, { messageId: 1 })).status,
    404,
  )
  // Переписка на месте: ничего из перечисленного не сработало.
  const alive = await (await http.get(`/v1/sessions/${sessionId}?profile=${keyed.id}`, MIKE)).json()
  assert.equal(alive.ok, true)
  await http.close()
  sessions.close()
})

test('действительный ключ другого имени — 404, а не 403: отказ не говорит о профилях', async () => {
  const { sessions } = open()
  const http = await serve({ sessions })
  const keyed = await create(http, 'ключевой', MIKE)

  const alien = await http.get(`/v1/profiles/${keyed.id}`, GUEST)
  assert.equal(alien.status, 404, 'годный ключ чужого имени — как несуществующий профиль')
  assert.equal((await alien.json()).code, 'unknown_profile')

  // А вот негодный заголовок — именно 403: он говорит о САМОМ заголовке.
  const bad = await http.get(`/v1/profiles/${keyed.id}`, WRONG)
  assert.equal(bad.status, 403)
  assert.equal((await bad.json()).code, 'bad_model_key')
  await http.close()
  sessions.close()
})

test('открытые профили ключом не затронуты: день 11 работает как до ADR', async () => {
  const { sessions } = open()
  const http = await serve({ sessions })
  const open_ = await create(http, 'открытый')

  // Открытый профиль читается и без ключа, и с любым ГОДНЫМ ключом: ключ
  // меняет, что видно сверх открытого, а не отбирает открытое.
  for (const key of [undefined, MIKE, GUEST]) {
    const response = await http.get(`/v1/profiles/${open_.id}`, key)
    assert.equal(response.status, 200, JSON.stringify(key))
    assert.equal((await response.json()).profile.keyName, null)
  }
  await http.close()
  sessions.close()
})
