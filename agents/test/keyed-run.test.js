// Запуск в ключевом профиле: какая модель разрешена, что уходит внешнему
// поставщику и суточный потолок имени (ADR 2026-10-07-1349, п. 2, 3, 5, 7).
// Требует Node 24 или флага --experimental-sqlite.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLayeredAgent, LAYERED_AGENT_ID } from '../src/layered.js'
import { createModelKeys } from '../src/model-keys.js'
import { budgetFor, DAY11_MODELS, inputBudgetFor, KEYED_MODEL, LAYERED_MODELS } from '../src/params.js'
import { createRuns } from '../src/runs.js'
import { createSessions } from '../src/sessions.js'
import { createStagedAgent } from '../src/staged.js'
import { ENV, LAYERED, REGISTRY } from './fixtures.js'

const DAY = 24 * 3600_000
const KEYED = KEYED_MODEL.id
const MIKE = 'M'.repeat(32)
const GUEST = 'G'.repeat(32)
const ENTRIES = [
  { name: 'mike', value: MIKE },
  { name: 'guest1', value: GUEST },
]

const ANSWER = {
  ok: true,
  text: 'Ответ модели без встроенных отказов.',
  provider: { id: KEYED, model: KEYED_MODEL.id, tier: 'self-hosted' },
  truncated: false,
  durationMs: 4000,
  usage: { inputTokens: 300, outputTokens: 40 },
}

/** Роутер-заглушка: помнит КАЖДЫЙ вызов — на этом стоит счёт вызовов. */
function router() {
  const calls = []
  const impl = async (url, options = {}) => {
    if (String(url).includes('/v1/models'))
      return { ok: true, status: 200, json: async () => ({ providers: [] }) }
    calls.push(JSON.parse(options.body))
    return { ok: true, status: 200, json: async () => ANSWER }
  }
  impl.calls = calls
  return impl
}

function setup({ entries = ENTRIES, fetchImpl = router() } = {}) {
  const sessions = createSessions({
    file: ':memory:',
    ttlMs: ENV.SESSION_TTL_HOURS * 3600_000,
    profileTtlMs: ENV.PROFILE_TTL_DAYS * DAY,
    log: () => {},
  })
  const runs = createRuns()
  const modelKeys = createModelKeys({ entries })
  const agent = createLayeredAgent({
    agent: LAYERED,
    runs,
    sessions,
    modelKeys,
    env: ENV,
    fetchImpl,
    log: () => {},
  })

  /** Профиль: с `keyName` — ключевой, без — открытый, как до ADR. */
  const profileWith = (keyName) => {
    const profile = sessions.createProfile({ name: keyName ?? 'открытый', keyName }).profile
    const sid = sessions.createSession({ profileId: profile.id }).id
    return { profile, sid }
  }

  const ask = async ({ profileId, sessionId, keyName = null, ...body }) => {
    const parsed = agent.parseInput(
      { profileId, sessionId, prompt: 'расскажи', ...body },
      { keyName },
    )
    if (!parsed.ok) return { refused: parsed }
    const run = runs.create({ agent, input: parsed.input })
    agent.hold(parsed.input.sessionId)
    await agent.execute(run)
    return { run, snapshot: runs.snapshot(run.id) }
  }
  return { sessions, runs, agent, fetchImpl, modelKeys, profileWith, ask }
}

// --- Список моделей -------------------------------------------------------

test('запись без отказов есть в describe() при настроенных ключах и нет при пустых', async () => {
  const on = await setup().agent.describe()
  assert.equal(
    on.models.some((m) => m.id === KEYED),
    true,
    'ключи настроены — запись предлагается',
  )
  assert.equal(on.models.length, 9, 'восемь прежних и закрытая')

  const off = await setup({ entries: [] }).agent.describe()
  assert.equal(
    off.models.some((m) => m.id === KEYED),
    false,
    'пустая MODEL_KEYS — записи нет вовсе',
  )
  assert.equal(off.models.length, 8, 'список дня 11 как до ADR')
})

test('закрытая запись не попала в LAYERED_MODELS: дни 13–15 её не видят', () => {
  assert.equal(
    LAYERED_MODELS.some((m) => m.id === KEYED),
    false,
    'общий список дней 11 и 13–15 не тронут',
  )
  assert.equal(DAY11_MODELS.at(-1).id, KEYED, 'она только в списке дня 11')
})

test('staged-agent с этой моделью — 400 «Неизвестная модель»', () => {
  const sessions = createSessions({
    file: ':memory:',
    ttlMs: ENV.SESSION_TTL_HOURS * 3600_000,
    profileTtlMs: ENV.PROFILE_TTL_DAYS * DAY,
    log: () => {},
  })
  const runs = createRuns()
  const staged = createStagedAgent({
    agent: REGISTRY.get('staged-agent'),
    runs,
    sessions,
    stageLog: null,
    env: ENV,
    fetchImpl: async () => {
      throw new Error('роутер вызван, хотя вызова быть не должно')
    },
    log: () => {},
  })
  const profile = sessions.createProfile({ name: 'открытый' }).profile
  const sid = sessions.createSession({ profileId: profile.id }).id
  const parsed = staged.parseInput({
    profileId: profile.id,
    sessionId: sid,
    prompt: 'привет',
    model: KEYED,
  })
  assert.equal(parsed.ok, false)
  assert.match(parsed.message, /Неизвестная модель/)
  sessions.close()
})

// --- Бюджет (params.js: поиск по DAY11_MODELS) ----------------------------

test('бюджет закрытой записи — её собственный, а не Haiku', () => {
  assert.equal(inputBudgetFor(KEYED), KEYED_MODEL.maxInputTokens)
  assert.equal(budgetFor(KEYED), KEYED_MODEL.maxChars)
  // Отрицательный контроль: предел Haiku — другое число, и подмена записи на
  // `MODELS[0]` была бы видна именно так.
  assert.notEqual(inputBudgetFor(KEYED), inputBudgetFor('anthropic-haiku'))
  assert.equal(inputBudgetFor('anthropic-haiku'), 40_000)
  assert.equal(inputBudgetFor(KEYED), 4500, 'по пределу ноутбука, а не облака')
})

// --- Кто и где может звать закрытую модель --------------------------------

test('закрытая модель в открытом профиле — 403, даже с верным ключом, роутер не вызван', async () => {
  const { profileWith, ask, fetchImpl } = setup()
  const { profile, sid } = profileWith(null)

  const refused = await ask({
    profileId: profile.id,
    sessionId: sid,
    model: KEYED,
    keyName: 'mike',
  })
  assert.equal(refused.refused.status, 403)
  assert.equal(refused.refused.code, 'model_key_required')
  assert.deepEqual(fetchImpl.calls, [], 'до роутера запрос не дошёл')
})

test('закрытая модель в ключевом профиле без ключа и с чужим именем — 403', async () => {
  const { profileWith, ask, fetchImpl } = setup()
  const { profile, sid } = profileWith('mike')

  for (const keyName of [null, 'guest1']) {
    const refused = await ask({ profileId: profile.id, sessionId: sid, model: KEYED, keyName })
    assert.equal(refused.refused.status, 403, `ключ ${keyName}`)
    assert.equal(refused.refused.code, 'model_key_required')
  }
  assert.deepEqual(fetchImpl.calls, [])
})

test('Haiku в ключевом профиле — 403: чужая модель получила бы текст без отказов', async () => {
  const { profileWith, ask, fetchImpl } = setup()
  const { profile, sid } = profileWith('mike')

  const refused = await ask({
    profileId: profile.id,
    sessionId: sid,
    model: 'anthropic-haiku',
    keyName: 'mike',
  })
  assert.equal(refused.refused.status, 403)
  assert.equal(refused.refused.code, 'keyed_profile_model')
  assert.deepEqual(fetchImpl.calls, [], 'роутер не вызван')
})

test('закрытая модель со своим ключом в своём профиле — роутер вызван с этим провайдером', async () => {
  const { profileWith, ask, fetchImpl } = setup()
  const { profile, sid } = profileWith('mike')

  const { snapshot } = await ask({
    profileId: profile.id,
    sessionId: sid,
    model: KEYED,
    keyName: 'mike',
  })
  assert.equal(snapshot.status, 'succeeded')
  assert.equal(fetchImpl.calls.length, 1)
  assert.equal(fetchImpl.calls[0].provider, KEYED, 'имя провайдера уехало роутеру')
  assert.equal(fetchImpl.calls[0].taskClass, 'layered_dialogue')
})

// --- Ничего не уходит внешнему поставщику (п. 3) --------------------------

test('запуск в ключевом профиле делает РОВНО ОДИН вызов роутера', async () => {
  const { sessions, profileWith, ask, fetchImpl } = setup()
  const { profile, sid } = profileWith('mike')

  // Два хода подряд и со стратегией сводки в запросе: именно так в открытом
  // профиле появляются второй и третий вызовы (сводка и пополнение).
  for (const prompt of ['первый вопрос', 'второй вопрос']) {
    const { snapshot } = await ask({
      profileId: profile.id,
      sessionId: sid,
      model: KEYED,
      keyName: 'mike',
      prompt,
      strategy: 'summary',
      summarizeAt: 500,
    })
    assert.equal(snapshot.status, 'succeeded', prompt)
  }

  assert.equal(fetchImpl.calls.length, 2, 'по одному вызову на ход, и ни одного лишнего')
  // Ни одного вызова класса `summarize` — именно им идут и сводка, и
  // пополнение памяти, оба в `anthropic-haiku`.
  assert.deepEqual(
    fetchImpl.calls.filter((c) => c.taskClass === 'summarize'),
    [],
    'ни сводки, ни пополнения',
  )
  assert.deepEqual(
    [...new Set(fetchImpl.calls.map((c) => c.provider))],
    [KEYED],
    'ни один вызов не ушёл внешнему поставщику',
  )

  // И в памяти профиля ничего не появилось: ни сводки, ни правил, ни тем.
  assert.equal(sessions.summary(sid) ?? null, null, 'сводки нет')
  assert.deepEqual(sessions.rulesOf(profile.id), [])
  assert.deepEqual(sessions.profile(profile.id).topics, [])
})

test('событие запуска говорит, что память профиля выключена', async () => {
  const { profileWith, ask } = setup()
  const { profile, sid } = profileWith('mike')
  const { snapshot } = await ask({
    profileId: profile.id,
    sessionId: sid,
    model: KEYED,
    keyName: 'mike',
  })
  const said = snapshot.events.find((e) => e.title?.includes('Память профиля выключена'))
  assert.notEqual(said, undefined, 'экран узнаёт об этом из события, а не из документации')
  assert.equal(said.data.memory, 'off')
})

test('открытый профиль по-прежнему зовёт пополнение: контрольная ветвь', async () => {
  const { profileWith, ask, fetchImpl } = setup()
  const { profile, sid } = profileWith(null)

  // Без этой проверки «ровно один вызов» выше удовлетворяла бы гипотеза
  // «пополнение не зовётся вообще никогда» — например, если бы его сломали.
  const { snapshot } = await ask({
    profileId: profile.id,
    sessionId: sid,
    model: 'anthropic-haiku',
    keyName: null,
  })
  assert.equal(snapshot.status, 'succeeded')
  assert.equal(fetchImpl.calls.length, 2, 'ответ и пополнение памяти')
  assert.equal(fetchImpl.calls[1].taskClass, 'summarize')
})

// --- Суточный потолок имени через ручку запуска --------------------------

test('потолок имени считается на запуск и не зависит от профиля', () => {
  const keys = createModelKeys({ entries: ENTRIES, dailyCap: 2 })
  assert.equal(keys.charge('mike').ok, true)
  assert.equal(keys.charge('mike').ok, true)
  const out = keys.charge('mike')
  assert.equal(out.ok, false)
  assert.equal(out.code, 'model_key_daily_cap')
  // Имя — не весь ключ: сосед по MODEL_KEYS считается отдельно.
  assert.equal(keys.charge('guest1').ok, true)
})
