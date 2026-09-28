// Поверхность управления инструментами агентов: диспетчер и перечень
// операций (ADR 2026-09-28-1820, пп. 1, 2, 8).
// Требует Node 24 или флага --experimental-sqlite.
//
// Поверхность — второй слушатель процесса `agents`, не путь внутри `/v1`.
// Здесь она поднимается настоящим HTTP-сервером и отвечает настоящему
// клиенту: свойства «401 на ключ в строке адреса» и «404 без проброса»
// проверяются на форме ответа, а не на внутреннем объекте.
//
// Модель в тестах не зовётся ни разу: роутер — заглушка.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createControlLog } from '../src/control/log.js'
import { CONTROL_PROMPT_IDS, CONTROL_UNEDITABLE_PROMPT_ID, OP_NAMES, OPS } from '../src/control/ops.js'
import { createControlService } from '../src/control/service.js'
import { createInvariants } from '../src/invariants.js'
import { PROFILE_PROMPT_IDS, STAGED15_MAX_TOKENS } from '../src/params.js'
import { createProfilePrompts } from '../src/prompts.js'
import { loadRegistry } from '../src/registry.js'
import { createRuns } from '../src/runs.js'
import { createSessions } from '../src/sessions.js'
import { createStageLog } from '../src/stage-log.js'
import { createStagedAgent, PREPARE_STAGES, PROMPT_AGENT_ID } from '../src/staged.js'
import { ENV } from './fixtures.js'

const here = dirname(fileURLToPath(import.meta.url))
const REGISTRY = loadRegistry(
  JSON.parse(readFileSync(join(here, '..', 'config', 'agents.json'), 'utf8')),
)

const KEY = 'C'.repeat(44)
const tmp = (name) => join(mkdtempSync(join(tmpdir(), 'control-')), name)

const answerReply = (text = 'ОТВЕТМОДЕЛИ о финтехе') => ({
  ok: true,
  text,
  provider: { id: 'anthropic-haiku', model: 'claude-haiku-4-5', tier: 'cloud-frontier' },
  truncated: false,
  durationMs: 100,
  usage: { inputTokens: 500, outputTokens: 40 },
})

/** Роутер-заглушка: живой модели в тестах нет ни на одном пути. */
function router() {
  const calls = []
  const impl = async (url, options = {}) => {
    if (String(url).includes('/v1/models'))
      return { ok: true, status: 200, json: async () => ({ providers: [] }) }
    const body = JSON.parse(options.body)
    calls.push(body)
    if (body.provider === 'kimi-k2.6') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ...answerReply('вердикт: принято\nзамечания:\nинварианты:') }),
      }
    }
    if (body.taskClass === 'summarize')
      return { ok: true, status: 200, json: async () => answerReply('тема: продолжить') }
    return { ok: true, status: 200, json: async () => answerReply() }
  }
  impl.calls = calls
  return impl
}

/**
 * Поверхность на настоящем порту, с настоящим хранилищем и настоящим агентом
 * дня 15. Возвращает клиента `call`, предъявляющего ключ по спецификации, и
 * сырой `raw` для проверок формы предъявления.
 */
async function setup({ controlKey = KEY, failsPerMin = 10, dailyCap = 10, fetchImpl = router() } = {}) {
  const env = {
    ...ENV,
    CONTROL_KEY: controlKey,
    CONTROL_PORT: 0,
    CONTROL_FAILS_PER_MIN: failsPerMin,
    CONTROL_MAX_DAILY_CALLS: dailyCap,
  }
  const sessions = createSessions({
    file: tmp('sessions.db'),
    ttlMs: env.SESSION_TTL_HOURS * 3600_000,
    profileTtlMs: env.PROFILE_TTL_DAYS * 24 * 3600_000,
    log: () => {},
  })
  const runs = createRuns()
  const invariants = createInvariants({ sessions })
  const agent = createStagedAgent({
    agent: REGISTRY.get(PROMPT_AGENT_ID),
    runs,
    sessions,
    stageLog: createStageLog({ file: tmp('stages.csv'), log: () => {} }),
    env,
    fetchImpl,
    log: () => {},
    invariants,
    prompts: createProfilePrompts({ sessions }),
    stages: PREPARE_STAGES,
    maxOutputTokens: STAGED15_MAX_TOKENS,
  })
  const agents = new Map([[PROMPT_AGENT_ID, agent]])
  const controlLogFile = tmp('control-log.db')
  const controlLog = createControlLog({ file: controlLogFile, keepDays: env.CONTROL_LOG_DAYS })
  const lines = []
  const handler = createControlService({
    sessions,
    invariants,
    agents,
    runs,
    controlLog,
    env,
    log: (entry) => lines.push(entry),
    fetchImpl,
  })
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  const raw = (path, options = {}) => fetch(`${base}${path}`, options)
  const call = async (path, { method = 'GET', body, key = controlKey, ...rest } = {}) => {
    const res = await raw(path, {
      method,
      headers: {
        ...(key === null ? {} : { authorization: `Bearer ${key}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(rest.headers ?? {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: res.status, headers: res.headers, json: await res.json().catch(() => null) }
  }

  const profile = sessions.createProfile({ name: 'Мика' }).profile
  const sid = sessions.createSession({ profileId: profile.id }).id
  const close = () => {
    server.close()
    controlLog.close()
    sessions.close()
  }
  return { env, sessions, runs, agent, invariants, controlLog, controlLogFile, call, raw, base, profile, sid, lines, close, fetchImpl }
}

const UUID = '11111111-1111-4111-8111-111111111111'

// --- Свойство 1: отказ по умолчанию ---------------------------------------

test('путь вне перечня — один 404 без подсказки, и ручки /v1 поверхностью не обслуживаются', async () => {
  const ctx = await setup()
  try {
    // `/v1` — не описка теста: именно эти ручки поверхность НЕ обслуживает,
    // и пробросить в них ей нечем. Ссылки на обработчик `/v1` у модуля нет.
    for (const path of [
      '/v1/profiles',
      '/v1/agents',
      '/healthz',
      '/',
      '/control',
      '/control/profiles/extra',
      '/control/profile.delete',
      '/control/prompts',
    ]) {
      const out = await ctx.call(path)
      assert.equal(out.status, 404, `путь ${path}`)
      assert.deepEqual(out.json, { ok: false, code: 'not_found' }, `тело ответа на ${path}`)
    }
    // Положительный контроль: перечень при этом работает — иначе «404 на всё»
    // удовлетворила бы и гипотеза «сервер сломан».
    assert.equal((await ctx.call('/control/profiles')).status, 200)
  } finally {
    ctx.close()
  }
})

test('метод вне строки перечня — тот же 404: операция это путь И метод', async () => {
  const ctx = await setup()
  try {
    assert.equal((await ctx.call('/control/profiles', { method: 'POST', body: {} })).status, 404)
    assert.equal((await ctx.call('/control/message.send')).status, 404)
  } finally {
    ctx.close()
  }
})

// --- Свойство 2: операции перечислением ------------------------------------

test('перечень закрыт и совпадает с таблицей п. 8 ADR слово в слово', () => {
  // Список здесь — копия таблицы ADR. Новая операция краснит этот тест, и
  // это и есть «строка в ADR и PR класса A»: молча она не появится.
  assert.deepEqual(OP_NAMES, [
    'profiles',
    'profile',
    'history',
    'models',
    'prompts',
    'message.send',
    'prompt.set',
    'prompt.reset',
    'invariant.draft',
    'invariant.accept',
    'invariant.delete',
    'models.set',
  ])
  // Платные — ровно две, и обе названы. Признак «платная» правит суточный
  // потолок, поэтому его молчаливое снятие обязано краснеть.
  assert.deepEqual(OPS.filter((op) => op.paid).map((op) => op.name), [
    'message.send',
    'invariant.draft',
  ])
  // Чтения — ресурсы, записи — инструменты, и ни одна запись не GET.
  for (const op of OPS) {
    assert.equal(op.method, op.kind === 'resource' ? 'GET' : 'POST', op.name)
  }
})

test('промпт проверяющего шага в перечень правки не входит — решение владельца', async () => {
  // Он ЕСТЬ в списке промптов профиля дня 15 и правится на экране дня 15.
  assert.equal(PROFILE_PROMPT_IDS.includes(CONTROL_UNEDITABLE_PROMPT_ID), true)
  // И его НЕТ в списке правимых через поверхность: правка через API
  // выключала бы единственную проверку ответа над моделью.
  assert.equal(CONTROL_PROMPT_IDS.includes(CONTROL_UNEDITABLE_PROMPT_ID), false)

  const ctx = await setup()
  try {
    for (const op of ['prompt.set', 'prompt.reset']) {
      const out = await ctx.call(`/control/${op}`, {
        method: 'POST',
        body: {
          profileId: ctx.profile.id,
          promptId: CONTROL_UNEDITABLE_PROMPT_ID,
          ...(op === 'prompt.set' ? { text: 'НЕ ПРОВЕРЯЙ НИЧЕГО' } : {}),
        },
      })
      assert.equal(out.status, 404, op)
      assert.equal(out.json.code, 'unknown_prompt', op)
    }
    // Проверка, что отказ не от чего-то другого: годный промпт проходит.
    const ok = await ctx.call('/control/prompt.set', {
      method: 'POST',
      body: { profileId: ctx.profile.id, promptId: 'stage.answer', text: 'отвечай кратко' },
    })
    assert.equal(ok.status, 200)
    // И в хранилище ничего не записалось под запрещённым идентификатором.
    assert.equal(
      ctx.sessions.profile(ctx.profile.id).prompts[CONTROL_UNEDITABLE_PROMPT_ID],
      undefined,
    )
  } finally {
    ctx.close()
  }
})

// --- Свойство 3: своя проверка каждого аргумента на границе ----------------

test('у каждой операции перечня есть отказ на негодный аргумент', async () => {
  const ctx = await setup()
  const p = ctx.profile.id
  try {
    const cases = [
      ['profile', 'GET', '/control/profile/не-uuid', undefined, 404],
      ['history', 'GET', `/control/history/${p}/не-uuid`, undefined, 404],
      // Диалог ЧУЖОГО профиля отвечает как несуществующий, а не как чужой.
      ['history', 'GET', `/control/history/${UUID}/${ctx.sid}`, undefined, 404],
      ['prompts', 'GET', `/control/prompts/${UUID}`, undefined, 404],
      ['message.send', 'POST', '/control/message.send', { profileId: p, sessionId: ctx.sid, text: '' }, 400],
      ['message.send', 'POST', '/control/message.send', { profileId: p, sessionId: ctx.sid, text: 'x', лишнее: 1 }, 400],
      ['prompt.set', 'POST', '/control/prompt.set', { profileId: p, promptId: 'stage.answer', text: '' }, 400],
      ['prompt.reset', 'POST', '/control/prompt.reset', { profileId: 'нет', promptId: 'stage.answer' }, 400],
      ['invariant.draft', 'POST', '/control/invariant.draft', { profileId: p, text: '  ' }, 400],
      ['invariant.accept', 'POST', '/control/invariant.accept', { profileId: p, text: 'т', ticket: '' }, 400],
      ['invariant.delete', 'POST', '/control/invariant.delete', { profileId: p, num: 0 }, 400],
      ['models.set', 'POST', '/control/models.set', { profileId: p, model: 'нет-такой-модели' }, 400],
      ['models.set', 'POST', '/control/models.set', { profileId: p }, 400],
    ]
    const covered = new Set()
    for (const [name, method, path, body, status] of cases) {
      const out = await ctx.call(path, { method, body })
      assert.equal(out.status, status, `${name}: ${path} ${JSON.stringify(body ?? {})}`)
      assert.equal(out.json.ok, false, name)
      covered.add(name)
    }
    // Каждая операция с аргументами покрыта негативным случаем. `profiles` и
    // `models` аргументов не имеют — их в списке и нет.
    for (const op of OPS) {
      if (op.params.length === 0 && op.kind === 'resource') continue
      assert.equal(covered.has(op.name), true, `нет негативного теста на ${op.name}`)
    }
  } finally {
    ctx.close()
  }
})

test('билет формулировщика не обходится: приём без него отказывает', async () => {
  const ctx = await setup()
  try {
    const out = await ctx.call('/control/invariant.accept', {
      method: 'POST',
      body: { profileId: ctx.profile.id, text: 'без выдумок', ticket: 'подделка' },
    })
    assert.equal(out.status, 400)
    assert.equal(out.json.code, 'no_ticket')
    assert.equal(ctx.sessions.profile(ctx.profile.id).invariants.length, 0)

    // Положительный контроль: с настоящим билетом тот же текст принимается —
    // значит отказ выше про билет, а не про текст.
    const ticket = ctx.invariants.ticket(ctx.profile.id, 'без выдумок')
    const good = await ctx.call('/control/invariant.accept', {
      method: 'POST',
      body: { profileId: ctx.profile.id, text: 'без выдумок', ticket },
    })
    assert.equal(good.status, 200)
    assert.equal(good.json.invariant.text, 'без выдумок')
  } finally {
    ctx.close()
  }
})

// --- Свойство 4: ключ по спецификации и только так -------------------------

test('ключ в строке адреса и в своём заголовке — 401, значения в журнале нет', async () => {
  const ctx = await setup()
  try {
    const byQuery = await ctx.call(`/control/profiles?key=${KEY}`)
    assert.equal(byQuery.status, 401)
    const byHeader = await ctx.call('/control/profiles', {
      headers: { 'x-control-key': KEY },
    })
    assert.equal(byHeader.status, 401)
    // По спецификации: 401 несёт форму обнаружения, без метаданных OAuth.
    assert.equal(byHeader.headers.get('www-authenticate'), 'Bearer realm="control"')
    // Ни в ответе, ни в журнале процесса значения нет.
    assert.equal(JSON.stringify(byHeader.json).includes(KEY), false)
    assert.equal(JSON.stringify(ctx.lines).includes(KEY), false)
  } finally {
    ctx.close()
  }
})

test('чужой ключ и отсутствие ключа — 401; годный — 200', async () => {
  const ctx = await setup()
  try {
    assert.equal((await ctx.call('/control/profiles', { key: null })).status, 401)
    assert.equal((await ctx.call('/control/profiles', { key: 'D'.repeat(44) })).status, 401)
    assert.equal((await ctx.call('/control/profiles')).status, 200)
  } finally {
    ctx.close()
  }
})

// --- Свойство 5: ключи не пересекаются, совпадение обнуляет ---------------

test('выключенная поверхность отвечает 503 control_disabled на всё, включая перечень', async () => {
  const ctx = await setup({ controlKey: null })
  try {
    for (const path of ['/control/profiles', '/control/message.send', '/что-угодно']) {
      const out = await ctx.call(path)
      assert.equal(out.status, 503, path)
      // Именно `control_disabled`, а не 401: «выключен» обязан быть отличим
      // от «чужой ключ», иначе оператор чинит ключ клиента вместо строки в
      // `agents.env`.
      assert.equal(out.json.code, 'control_disabled', path)
    }
  } finally {
    ctx.close()
  }
})

// --- Свойство 6: свой учёт -------------------------------------------------

test('успех и отказ дают по строке журнала; тексты сообщений записаны', async () => {
  const ctx = await setup()
  try {
    await ctx.call('/control/profiles')
    await ctx.call('/control/profiles', { key: 'D'.repeat(44) })
    await ctx.call('/control/prompt.set', {
      method: 'POST',
      body: { profileId: ctx.profile.id, promptId: 'stage.answer', text: 'отвечай кратко' },
    })
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(ctx.controlLogFile)
    const rows = db.prepare('SELECT * FROM control_log ORDER BY id').all()
    db.close()
    assert.deepEqual(
      rows.map((r) => [r.op, r.outcome]),
      [
        ['profiles', 'ok'],
        ['-', 'unauthorized'],
        ['prompt.set', 'ok'],
      ],
    )
    // У отказа есть адрес соединения — иначе залп был бы безымянен.
    assert.notEqual(rows[1].remote, null)
    // Текст, присланный операцией, в журнале есть (решение владельца).
    assert.equal(JSON.parse(rows[2].texts).text, 'отвечай кратко')
    // Значения ключа нет нигде в журнале.
    assert.equal(JSON.stringify(rows).includes('D'.repeat(44)), false)
  } finally {
    ctx.close()
  }
})

test('журнал наружу не выносится: операции его чтения в перечне нет', () => {
  assert.equal(OP_NAMES.some((name) => /log|журнал/i.test(name)), false)
  const source = readFileSync(join(here, '..', 'src', 'control', 'ops.js'), 'utf8')
  // Ни одна строка перечня не получает журнал: его нет среди зависимостей,
  // которые `ops.js` разбирает у себя на входе.
  assert.equal(source.includes('controlLog'), false)
})

// --- Свойство 7: лимитеры --------------------------------------------------

test('после N отказов за минуту адрес получает 429 — до сравнения ключа', async () => {
  const ctx = await setup({ failsPerMin: 3 })
  try {
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await ctx.call('/control/profiles', { key: 'D'.repeat(44) })).status, 401)
    }
    // Верным ключом: если бы окно стояло после сравнения, попытка прошла бы.
    const out = await ctx.call('/control/profiles')
    assert.equal(out.status, 429)
    assert.equal(out.json.code, 'too_many_attempts')
  } finally {
    ctx.close()
  }
})

test('адрес в журнале — сокет, а не X-Forwarded-For: залп с подставными адресами всё равно ловится окном', async () => {
  // Держатель под `remoteOf`. Он нужен не для красоты учёта: `remote` лежит
  // в `control_log` В ОДНОЙ СТРОКЕ с текстом сообщения посетителя и живёт
  // там 30 суток. Заголовок сюда придёт в тот день, когда у поверхности
  // появится маршрут в `Caddyfile` — а каждый маршрут дня ставит
  // `header_up X-Forwarded-For {client_ip}`. Правки этого кода для отказа
  // не требуется вовсе, поэтому комментарий его не держит.
  const ctx = await setup({ failsPerMin: 3 })
  const SPOOF = '203.0.113.9'
  try {
    // Залп: каждая попытка несёт СВОЙ подставной адрес. Если бы окно велось
    // по заголовку, каждая попадала бы в своё ведро и 429 не наступил бы
    // никогда. Именно это и различает две гипотезы — одного запроса тут мало.
    for (let i = 0; i < 3; i += 1) {
      const out = await ctx.call('/control/profiles', {
        key: 'D'.repeat(44),
        headers: { 'x-forwarded-for': `${SPOOF}, 198.51.100.${i}` },
      })
      assert.equal(out.status, 401, `попытка ${i}`)
    }
    const blocked = await ctx.call('/control/profiles', {
      headers: { 'x-forwarded-for': '198.51.100.250' },
    })
    assert.equal(blocked.status, 429, 'окно ведётся по сокету, а не по заголовку')

    // И в журнале — адрес соединения, а не подставленный. Проверяется и то,
    // что подставного там нет, и то, что записан именно локальный сокет:
    // «не равно SPOOF» удовлетворил бы и пустой столбец.
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(ctx.controlLogFile)
    const remotes = db.prepare('SELECT remote FROM control_log').all().map((r) => r.remote)
    db.close()
    assert.equal(remotes.length > 0, true, 'строки журнала есть')
    for (const remote of remotes) {
      assert.equal(String(remote).includes(SPOOF), false, 'подставного адреса в журнале нет')
      assert.match(String(remote), /127\.0\.0\.1$/, 'записан адрес соединения')
    }
  } finally {
    ctx.close()
  }
})

test('суточный потолок платных операций считается ДО вызова модели', async () => {
  const ctx = await setup({ dailyCap: 1 })
  try {
    // Первый платный вызов слот занимает — пусть даже сам отказывает.
    await ctx.call('/control/invariant.draft', {
      method: 'POST',
      body: { profileId: ctx.profile.id, text: 'отвечай по-русски' },
    })
    assert.equal(ctx.controlLog.paidToday(), 1)
    const before = ctx.fetchImpl.calls.length

    const out = await ctx.call('/control/invariant.draft', {
      method: 'POST',
      body: { profileId: ctx.profile.id, text: 'ещё одно правило' },
    })
    assert.equal(out.status, 429)
    assert.equal(out.json.code, 'daily_cap')
    // Различает гипотезы: модель при отказе по потолку НЕ звалась ни разу.
    assert.equal(ctx.fetchImpl.calls.length, before)

    // Бесплатная операция потолком платных не задета.
    assert.equal((await ctx.call('/control/profiles')).status, 200)
  } finally {
    ctx.close()
  }
})

// --- Свойство 8: свой ответ ------------------------------------------------

test('ответы операций — свой JSON без ключей и адресов (I-1)', async () => {
  const ctx = await setup()
  try {
    ctx.sessions.savePrompt({
      profileId: ctx.profile.id,
      promptId: 'stage.answer',
      text: 'отвечай кратко',
    })
    const seen = []
    for (const path of [
      '/control/profiles',
      `/control/profile/${ctx.profile.id}`,
      `/control/history/${ctx.profile.id}/${ctx.sid}`,
      '/control/models',
      `/control/prompts/${ctx.profile.id}`,
    ]) {
      const out = await ctx.call(path)
      assert.equal(out.status, 200, path)
      const dump = JSON.stringify(out.json)
      seen.push(dump)
      for (const secret of [KEY, ENV.AGENT_KEY, ENV.ROUTER_APP_KEY, ENV.ROUTER_URL, '8086']) {
        assert.equal(dump.includes(secret), false, `${path} не содержит ${secret}`)
      }
    }
    // Ответы непустые: пустой ответ прошёл бы проверку выше молча.
    for (const dump of seen) assert.equal(dump.length > 20, true)
  } finally {
    ctx.close()
  }
})

// --- Перечень под нагрузкой: что операции на самом деле делают -------------

test('чтения отдают то, что лежит в хранилище', async () => {
  const ctx = await setup()
  try {
    const list = await ctx.call('/control/profiles')
    assert.equal(list.json.profiles.length, 1)
    assert.equal(list.json.profiles[0].name, 'Мика')

    ctx.sessions.addInvariant({ profileId: ctx.profile.id, text: 'без выдумок' })
    const one = await ctx.call(`/control/profile/${ctx.profile.id}`)
    assert.deepEqual(one.json.profile.invariants, [{ num: 1, text: 'без выдумок' }])
    assert.equal(one.json.profile.sessions[0].id, ctx.sid)

    const models = await ctx.call('/control/models')
    assert.equal(models.json.models.length > 0, true)
    assert.equal(typeof models.json.models[0].id, 'string')

    const prompts = await ctx.call(`/control/prompts/${ctx.profile.id}`)
    const answer = prompts.json.prompts.find((p) => p.promptId === 'stage.answer')
    assert.equal(answer.source, 'registry')
    assert.equal(answer.editable, true)
    const verify = prompts.json.prompts.find((p) => p.promptId === CONTROL_UNEDITABLE_PROMPT_ID)
    // Виден, но не правится: показать промпт и позволить его снять — разное.
    assert.equal(verify.editable, false)
  } finally {
    ctx.close()
  }
})

test('prompt.set правит промпт профиля, prompt.reset возвращает умолчание', async () => {
  const ctx = await setup()
  try {
    await ctx.call('/control/prompt.set', {
      method: 'POST',
      body: { profileId: ctx.profile.id, promptId: 'stage.answer', text: 'ПРОМПТ ПОВЕРХНОСТИ' },
    })
    let prompts = await ctx.call(`/control/prompts/${ctx.profile.id}`)
    let answer = prompts.json.prompts.find((p) => p.promptId === 'stage.answer')
    assert.equal(answer.text, 'ПРОМПТ ПОВЕРХНОСТИ')
    assert.equal(answer.source, 'profile')

    await ctx.call('/control/prompt.reset', {
      method: 'POST',
      body: { profileId: ctx.profile.id, promptId: 'stage.answer' },
    })
    prompts = await ctx.call(`/control/prompts/${ctx.profile.id}`)
    answer = prompts.json.prompts.find((p) => p.promptId === 'stage.answer')
    assert.equal(answer.source, 'registry')
    assert.notEqual(answer.text, 'ПРОМПТ ПОВЕРХНОСТИ')
  } finally {
    ctx.close()
  }
})

test('models.set правит две настройки и не стирает остальной столбец профиля', async () => {
  const ctx = await setup()
  try {
    ctx.sessions.saveStagedSettings({
      profileId: ctx.profile.id,
      settings: { model: 'anthropic-haiku', reviewRounds: 3, maxTokens15: 5000 },
    })
    const out = await ctx.call('/control/models.set', {
      method: 'POST',
      body: { profileId: ctx.profile.id, reviewModel: 'kimi-k2.6' },
    })
    assert.equal(out.status, 200, JSON.stringify(out.json))
    const saved = ctx.sessions.profile(ctx.profile.id).stagedSettings
    assert.equal(saved.reviewModel, 'kimi-k2.6')
    // Соседние настройки на месте: поверхность правит две, а не заменяет блок.
    assert.equal(saved.model, 'anthropic-haiku')
    assert.equal(saved.reviewRounds, 3)
    assert.equal(saved.maxTokens15, 5000)
  } finally {
    ctx.close()
  }
})

test('invariant.delete снимает правило профиля', async () => {
  const ctx = await setup()
  try {
    ctx.sessions.addInvariant({ profileId: ctx.profile.id, text: 'без выдумок' })
    const out = await ctx.call('/control/invariant.delete', {
      method: 'POST',
      body: { profileId: ctx.profile.id, num: 1 },
    })
    assert.equal(out.status, 200)
    assert.equal(ctx.sessions.profile(ctx.profile.id).invariants.length, 0)
    // Повтор — 404: удалять нечего, и это отличимо от успеха.
    assert.equal(
      (
        await ctx.call('/control/invariant.delete', {
          method: 'POST',
          body: { profileId: ctx.profile.id, num: 1 },
        })
      ).status,
      404,
    )
  } finally {
    ctx.close()
  }
})

test('message.send доводит запуск до конца и отдаёт ответ, а история его помнит', async () => {
  const ctx = await setup()
  try {
    const out = await ctx.call('/control/message.send', {
      method: 'POST',
      body: { profileId: ctx.profile.id, sessionId: ctx.sid, text: 'что нового в финтехе' },
    })
    assert.equal(out.status, 200, JSON.stringify(out.json))
    assert.equal(out.json.answer, 'ОТВЕТМОДЕЛИ о финтехе')
    const history = await ctx.call(`/control/history/${ctx.profile.id}/${ctx.sid}`)
    assert.deepEqual(
      history.json.messages.map((m) => m.role),
      ['user', 'agent'],
    )
    assert.equal(history.json.messages[0].text, 'что нового в финтехе')
  } finally {
    ctx.close()
  }
})

test('без журнала платные операции выключены, а бесплатные работают', async () => {
  const ctx = await setup()
  try {
    // Журнала нет — счётчика суток тоже нет: это один объект. Поверхность,
    // выполняющая платную операцию без счётчика, МОЛЧА теряет денежную
    // защиту, и узнать об этом было бы нечем.
    const handler = createControlService({
      sessions: ctx.sessions,
      invariants: ctx.invariants,
      agents: new Map([[PROMPT_AGENT_ID, ctx.agent]]),
      runs: ctx.runs,
      controlLog: null,
      env: ctx.env,
      log: () => {},
      fetchImpl: ctx.fetchImpl,
    })
    const server = createServer(handler)
    // Закрывается в `finally` ниже, а не после последней проверки: упавшая
    // проверка иначе оставила бы открытый порт, и прогон висел бы до таймаута
    // вместо того, чтобы покраснеть. Проверено на деле красной ветвью.
    ctx.extra = server
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    const ask = async (path, body) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${KEY}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      return { status: res.status, json: await res.json() }
    }
    const before = ctx.fetchImpl.calls.length
    const paid = await ask('/control/invariant.draft', {
      profileId: ctx.profile.id,
      text: 'отвечай по-русски',
    })
    assert.equal(paid.status, 503)
    assert.equal(paid.json.code, 'no_control_log')
    // Различает гипотезы: модель не звалась.
    assert.equal(ctx.fetchImpl.calls.length, before)
    // Бесплатные чтения при этом работают: отказывает то, что без журнала
    // работать не вправе, и только оно.
    assert.equal((await ask('/control/profiles')).status, 200)
  } finally {
    ctx.extra?.close()
    ctx.close()
  }
})
