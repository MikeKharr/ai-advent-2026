// День 13: машина состояний запуска (ADR 2026-09-21-1747, критерии 1–16).
// Тесты идут от критериев приёмки записи, а не от написанного кода.
// Требует Node 24 или флага --experimental-sqlite.

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadRegistry } from '../src/registry.js'
import { createRuns } from '../src/runs.js'
import { createService } from '../src/service.js'
import { createSessions } from '../src/sessions.js'
import { createStageLog, STAGE_LOG_COLUMNS } from '../src/stage-log.js'
import { createStagedAgent, STAGES } from '../src/staged.js'
import { ENV, fakeArchive } from './fixtures.js'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const STAGED = loadRegistry(
  JSON.parse(readFileSync(join(here, '..', 'config', 'agents.json'), 'utf8')),
).get('staged-agent')

/** Тексты модели: ни один из них не должен попасть в события, кроме замечаний. */
const ANSWER_TEXT = 'ОТВЕТМОДЕЛИ про раунды финтеха'
const DELTA_TEXT = 'тема: продолжить\nфакт: ФАКТМОДЕЛИ о раунде\nправило: тон — ПРАВИЛОМОДЕЛИ'
const REMARKS = 'ЗАМЕЧАНИЕМОДЕЛИ: ответ длиннее одного слова'

const answerReply = (text = ANSWER_TEXT, truncated = false) => ({
  ok: true,
  text,
  provider: { id: 'anthropic-haiku', model: 'claude-haiku-4-5', tier: 'cloud-frontier' },
  truncated,
  durationMs: 100,
  usage: { inputTokens: 500, outputTokens: 40 },
})

const verdictReply = (text) => ({
  ok: true,
  text,
  provider: { id: 'kimi-k2.6', model: 'kimi-k2.6', tier: 'cloud' },
  truncated: false,
  durationMs: 80,
  usage: { inputTokens: 300, outputTokens: 20 },
})

const deltaReply = {
  ok: true,
  text: DELTA_TEXT,
  provider: { id: 'anthropic-haiku', model: 'claude-haiku-4-5', tier: 'cloud-frontier' },
  truncated: false,
  durationMs: 90,
  usage: { inputTokens: 400, outputTokens: 30 },
}

/**
 * Поддельный роутер: ответ рабочей модели, вердикт проверяющей и пополнение
 * различаются провайдером и классом задачи. `hang` держит вызов ответа, пока
 * его не оборвут сигналом, — так проверяется пауза на вызове.
 */
function router({
  answers = [answerReply()],
  verdicts = [verdictReply('вердикт: принято\nзамечания:')],
  delta = deltaReply,
  hangAnswer = false,
  onAnswerStart = () => {},
} = {}) {
  const calls = []
  let answerNo = 0
  let verdictNo = 0
  const impl = async (url, options = {}) => {
    if (String(url).includes('/v1/models'))
      return { ok: true, status: 200, json: async () => ({ providers: [] }) }
    const body = JSON.parse(options.body)
    calls.push(body)
    if (body.taskClass === 'summarize') {
      return { ok: true, status: 200, json: async () => delta }
    }
    if (body.provider === 'kimi-k2.6') {
      const reply = verdicts[Math.min(verdictNo++, verdicts.length - 1)]
      if (reply instanceof Error) throw reply
      return { ok: true, status: 200, json: async () => reply }
    }
    onAnswerStart(calls.length)
    if (hangAnswer) {
      // Роутер молчит: вызов заканчивается только обрывом сигнала.
      return new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('прервано')
          error.name = 'AbortError'
          reject(error)
        })
      })
    }
    const reply = answers[Math.min(answerNo++, answers.length - 1)]
    if (reply instanceof Error) throw reply
    return { ok: true, status: 200, json: async () => reply }
  }
  impl.calls = calls
  impl.answers = () => calls.filter((c) => c.taskClass === 'layered_dialogue' && c.provider !== 'kimi-k2.6')
  impl.verdicts = () => calls.filter((c) => c.provider === 'kimi-k2.6')
  return impl
}

function setup({ fetchImpl = router(), pauseTtlMinutes = 60, stageLogFile = null } = {}) {
  const env = { ...ENV, PAUSE_TTL_MINUTES: pauseTtlMinutes }
  const sessions = createSessions({
    file: ':memory:',
    ttlMs: env.SESSION_TTL_HOURS * 3600_000,
    profileTtlMs: env.PROFILE_TTL_DAYS * 24 * 3600_000,
    log: () => {},
  })
  const runs = createRuns()
  const stageLog = stageLogFile ? createStageLog({ file: stageLogFile, log: () => {} }) : null
  const agent = createStagedAgent({
    agent: STAGED,
    runs,
    sessions,
    stageLog,
    env,
    fetchImpl,
    log: () => {},
  })
  const profile = sessions.createProfile({ name: 'Мика' }).profile
  const sid = sessions.createSession({ profileId: profile.id }).id
  const start = (body = {}) => {
    const parsed = agent.parseInput({
      profileId: profile.id,
      sessionId: sid,
      prompt: 'что нового',
      ...body,
    })
    if (!parsed.ok) return { refused: parsed.message }
    const run = runs.create({ agent, input: parsed.input })
    agent.hold(parsed.input.sessionId)
    return { run, done: agent.execute(run) }
  }
  const parse = (body = {}) =>
    agent.parseInput({ profileId: profile.id, sessionId: sid, prompt: 'что нового', ...body })
  /** Правила профиля настоящими операциями хранилища: по пять за вызов. */
  const seedRules = (count, chars = 300) => {
    const aliveId = sessions.append({ sessionId: sid, role: 'user', text: 'о чём мы', tokens: 5 })
    for (let i = 0; i < count; i += 5) {
      sessions.rememberLayers({
        sessionId: sid,
        profileId: profile.id,
        aliveId,
        topic: { kind: 'continue' },
        facts: [],
        rules: Array.from({ length: Math.min(5, count - i) }, (_, k) => ({
          key: `правило-${i + k}`,
          value: 'я'.repeat(chars),
        })),
      })
    }
  }
  const ask = async (body) => {
    const started = start(body)
    if (started.refused) return started
    await started.done
    return { run: started.run, snapshot: runs.snapshot(started.run.id) }
  }
  return { env, sessions, runs, agent, fetchImpl, stageLog, profile, sid, start, ask, parse, seedRules }
}

const until = async (predicate, limitMs = 2000) => {
  const deadline = Date.now() + limitMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('условие не наступило')
}

const stageEvents = (snapshot) => snapshot.events.filter((e) => e.stage === 'state')

// --- Критерий 1: шесть этапов по порядку, промпт у каждого вызова ---------

test('запуск даёт шесть событий state по порядку; у llm_call есть промпт и его отпечаток', async () => {
  const { ask } = setup()
  const { snapshot } = await ask()

  assert.equal(snapshot.status, 'succeeded')
  assert.deepEqual(
    stageEvents(snapshot).map((e) => e.data.state),
    STAGES.map((s) => s.id),
  )
  for (const event of stageEvents(snapshot)) {
    assert.equal(event.data.of, 6)
    assert.ok(event.data.index >= 1 && event.data.index <= 6)
    assert.equal(event.data.round, 1)
  }
  const calls = snapshot.events.filter((e) => e.stage === 'llm_call')
  assert.ok(calls.length >= 2, 'ответ и пополнение — как минимум два вызова')
  for (const call of calls) {
    assert.ok(call.data.state, 'вызов назван этапом')
    assert.ok(call.data.promptId, 'у вызова есть идентификатор промпта')
    assert.match(call.data.promptSha, /^[0-9a-f]{8}$/)
    assert.ok(call.data.promptTokens > 0)
    assert.ok(call.data.contextTokens >= 0)
  }
  const received = snapshot.events.find((e) => e.stage === 'received')
  assert.equal(received.data.model, 'anthropic-haiku')
  assert.equal(received.data.reviewModel, 'kimi-k2.6')
  assert.equal(received.data.reviewRounds, 2)
})

test('describe(): шесть этапов с промптом или правилом и предел кругов', async () => {
  const { agent } = setup()
  const described = await agent.describe()

  assert.deepEqual(
    described.stages.map((s) => s.id),
    STAGES.map((s) => s.id),
  )
  const withPrompt = described.stages.filter((s) => s.prompt !== null)
  assert.equal(withPrompt.length, 4, 'промпт у четырёх этапов с вызовом')
  for (const stage of described.stages) assert.ok(stage.rule.length > 0)
  assert.deepEqual(described.limits.reviewRounds, { min: 1, max: 3, default: 2 })
  assert.equal(described.limits.contextTokens, 32_000)
})

// --- Критерии 2–4: пауза, обрыв вызова, возобновление ---------------------

test('пауза на этапе без вызова: вызова модели нет до возобновления, beat не идёт', async () => {
  const { start, runs, fetchImpl } = setup()
  const started = start()
  // Пауза нажата сразу: ближайшие ворота держат запуск до «Приёма».
  runs.pause(started.run.id)
  await until(() => runs.snapshot(started.run.id).events.some((e) => e.stage === 'paused'))

  assert.equal(fetchImpl.answers().length, 0, 'вызова модели на паузе не было')
  const snapshot = runs.snapshot(started.run.id)
  assert.equal(snapshot.events.some((e) => e.stage === 'beat'), false, 'на паузе ударов нет')
  assert.equal(snapshot.paused, true)

  runs.resume(started.run.id)
  await started.done
  const done = runs.snapshot(started.run.id)
  assert.equal(done.status, 'succeeded')
  assert.ok(done.events.some((e) => e.stage === 'resumed'))
  assert.equal(fetchImpl.answers().length, 1)
})

test('пауза на вызове: fetch оборван, исход interrupted, возобновление повторяет этап', async () => {
  let starts = 0
  const impl = router({ hangAnswer: false, onAnswerStart: () => (starts += 1) })
  // Первый вызов висит, второй отвечает: подменяем на лету.
  const hanging = router({ hangAnswer: true, onAnswerStart: () => (starts += 1) })
  let useHanging = true
  const fetchImpl = async (url, options) =>
    useHanging && !String(url).includes('/v1/models') && JSON.parse(options.body).provider === 'anthropic-haiku'
      ? hanging(url, options)
      : impl(url, options)
  fetchImpl.answers = () => [...hanging.answers(), ...impl.answers()]

  const { start, runs, sessions, sid } = setup({ fetchImpl })
  const started = start()
  await until(() => starts >= 1)
  runs.pause(started.run.id)

  await until(() => runs.snapshot(started.run.id).events.some((e) => e.title === 'Вызов прерван'))
  const interrupted = runs.snapshot(started.run.id)
  assert.equal(interrupted.interruptedCall, true)
  assert.equal(interrupted.events.find((e) => e.title === 'Вызов прерван').data.state, 'answer')

  useHanging = false
  runs.resume(started.run.id)
  await started.done
  const done = runs.snapshot(started.run.id)
  assert.equal(done.status, 'succeeded')
  assert.equal(starts, 2, 'прерванный вызов повторён')
  // Реплика посетителя записана один раз, несмотря на повторный вход в этап.
  const mine = sessions.history(sid).filter((m) => m.role === 'user')
  assert.equal(mine.length, 1)
})

test('возобновление без прерванного вызова повторного запроса не делает', async () => {
  const { start, runs, fetchImpl } = setup()
  const started = start()
  runs.pause(started.run.id)
  await until(() => runs.snapshot(started.run.id).events.some((e) => e.stage === 'paused'))
  runs.resume(started.run.id)
  await started.done
  assert.equal(fetchImpl.answers().length, 1)
  assert.equal(fetchImpl.verdicts().length, 1)
})

// --- Критерий 6: срок паузы ----------------------------------------------

test('пауза дольше срока: запуск отменён, замок снят, реплика записана, end ушёл', async () => {
  const { start, runs, agent, sessions, sid } = setup({ pauseTtlMinutes: 0.005 })
  const started = start()
  const ended = []
  runs.subscribe(started.run.id, (m) => m.type === 'end' && ended.push(m))
  runs.pause(started.run.id)
  await started.done

  const snapshot = runs.snapshot(started.run.id)
  assert.equal(snapshot.status, 'cancelled')
  assert.equal(agent.isBusy(sid), false, 'замок сессии снят')
  assert.equal(ended.length, 1, 'end ушёл слушателям')
  const texts = sessions.history(sid).map((m) => m.text)
  assert.ok(texts.some((t) => t.startsWith('Запуск отменён')), 'реплика агента записана')
})

// --- Критерий 8: потолок этапа -------------------------------------------

test('потолок этапа: 32 001 токен контекста отвергнут на границе, 32 000 проходит', async () => {
  const { parse, ask } = setup()
  assert.match(parse({ contextTokens: 32_001 }).message, /Размер контекста/)
  assert.equal(parse({ contextTokens: 32_000 }).ok, true)
  const { snapshot } = await ask({ contextTokens: 32_000 })
  assert.equal(snapshot.status, 'succeeded')
})

test('на модели с малым пределом отказ называет её предел, а не 32 000', async () => {
  const { seedRules, ask, fetchImpl } = setup()
  // Правила профиля крупнее предела Groq: сборка в него не влезает.
  seedRules(40)
  const { snapshot } = await ask({ model: 'groq-qwen3.6-27b' })
  assert.equal(snapshot.status, 'failed')
  assert.equal(snapshot.error.code, 'budget_too_small')
  assert.match(snapshot.error.message, /потолок этапа сейчас 4300/)
  assert.equal(fetchImpl.answers().length, 0, 'до вызова дело не дошло')
})

test('те же правила на Haiku укладываются в потолок 32 000', async () => {
  const { seedRules, ask, fetchImpl } = setup()
  seedRules(40)
  const { snapshot } = await ask()
  assert.equal(snapshot.status, 'succeeded')
  assert.equal(fetchImpl.answers().length, 1)
})

// --- Критерии 13–15: круг проверки ---------------------------------------

test('отказ проверки при пределе 2 возвращает на сборку ровно один раз', async () => {
  const fetchImpl = router({
    verdicts: [
      verdictReply(`вердикт: отклонено\nзамечания: ${REMARKS}`),
      verdictReply(`вердикт: отклонено\nзамечания: ${REMARKS}`),
    ],
  })
  const { ask, sessions, sid } = setup({ fetchImpl })
  const { snapshot } = await ask({ reviewRounds: 2 })

  assert.equal(snapshot.status, 'succeeded')
  assert.equal(fetchImpl.answers().length, 2, 'два вызова ответа и не больше')
  assert.equal(fetchImpl.verdicts().length, 2)
  // Во втором круге в запрос уходит блок замечаний.
  assert.ok(fetchImpl.answers()[1].input.includes('<review>'))
  assert.equal(fetchImpl.answers()[0].input.includes('<review>'), false)
  const states = stageEvents(snapshot).map((e) => `${e.data.state}:${e.data.round}`)
  assert.deepEqual(states, [
    'intake:1',
    'assemble:1',
    'answer:1',
    'verify:1',
    'assemble:2',
    'answer:2',
    'verify:2',
    'replenish:2',
    'deliver:2',
  ])
  assert.equal(snapshot.result.marked, true)
  assert.equal(snapshot.result.review.verdict, 'rejected')
  assert.equal(snapshot.result.rounds, 2, 'сделано два круга — день вернёт лишние слоты')
  // Отклонённый ответ в переписке не остаётся: он там один, последний.
  const agentMessages = sessions.history(sid).filter((m) => m.role === 'agent')
  assert.equal(agentMessages.length, 1)
})

test('предел кругов 1: возврата нет, вердикт — пометкой', async () => {
  const fetchImpl = router({
    verdicts: [verdictReply(`вердикт: отклонено\nзамечания: ${REMARKS}`)],
  })
  const { ask } = setup({ fetchImpl })
  const { snapshot } = await ask({ reviewRounds: 1 })
  assert.equal(fetchImpl.answers().length, 1)
  assert.equal(snapshot.result.marked, true)
  assert.equal(snapshot.result.rounds, 1)
})

test('пустой ответ — возврат без вызова проверяющего', async () => {
  const fetchImpl = router({ answers: [answerReply(''), answerReply()] })
  const { ask } = setup({ fetchImpl })
  const { snapshot } = await ask({ reviewRounds: 2 })
  assert.equal(fetchImpl.answers().length, 2)
  assert.equal(fetchImpl.verdicts().length, 1, 'пустой ответ проверяющего не звал')
  assert.equal(snapshot.status, 'succeeded')
})

test('обрезанный ответ — пометка без возврата и без вызова проверяющего', async () => {
  const fetchImpl = router({ answers: [answerReply(ANSWER_TEXT, true)] })
  const { ask } = setup({ fetchImpl })
  const { snapshot } = await ask({ reviewRounds: 3 })
  assert.equal(fetchImpl.answers().length, 1)
  assert.equal(fetchImpl.verdicts().length, 0)
  assert.equal(snapshot.result.review.verdict, 'marked')
})

test('неразобранный вердикт — принято с пометкой, круг не жжётся', async () => {
  const fetchImpl = router({ verdicts: [verdictReply('мне нечего сказать')] })
  const { ask } = setup({ fetchImpl })
  const { snapshot } = await ask({ reviewRounds: 3 })
  assert.equal(fetchImpl.answers().length, 1)
  assert.equal(snapshot.result.review.verdict, 'unparsed')
  assert.equal(snapshot.result.marked, true)
})

test('проверяющая модель не тянет запрос — проверка пропущена без вызова', async () => {
  const fetchImpl = router()
  const { ask, seedRules } = setup({ fetchImpl })
  // Правила уходят проверяющему целиком: у Groq на них предела не хватает.
  seedRules(40)
  const { snapshot } = await ask({ reviewModel: 'groq-qwen3.6-27b' })
  const skipped = snapshot.events.find((e) => e.data?.verdict === 'skipped')
  assert.ok(skipped, 'проверка пропущена с пометкой')
  assert.equal(fetchImpl.calls.filter((c) => c.provider === 'groq-qwen3.6-27b').length, 0)
})

// --- Указание автора: модельный текст только в замечаниях ----------------

test('страж: текст модели есть только в событии planning этапа verify', async () => {
  const fetchImpl = router({
    verdicts: [verdictReply(`вердикт: отклонено\nзамечания: ${REMARKS}`), verdictReply('вердикт: принято')],
  })
  const { ask } = setup({ fetchImpl })
  const { snapshot } = await ask({ reviewRounds: 2 })

  const MODEL_TEXTS = ['ОТВЕТМОДЕЛИ', 'ФАКТМОДЕЛИ', 'ПРАВИЛОМОДЕЛИ', 'ЗАМЕЧАНИЕМОДЕЛИ']
  for (const event of snapshot.events) {
    const json = JSON.stringify(event)
    const isRemarks = event.stage === 'planning' && event.data.state === 'verify'
    for (const marker of MODEL_TEXTS) {
      if (isRemarks && marker === 'ЗАМЕЧАНИЕМОДЕЛИ') continue
      assert.equal(
        json.includes(marker),
        false,
        `${marker} в событии ${event.stage} «${event.title}»`,
      )
    }
  }
  const remarksEvent = snapshot.events.find(
    (e) => e.stage === 'planning' && e.data.state === 'verify' && e.data.verdict === 'rejected',
  )
  assert.ok(remarksEvent.detail.includes('ЗАМЕЧАНИЕМОДЕЛИ'))
  assert.deepEqual(Object.keys(remarksEvent.data).sort(), ['remarksChars', 'round', 'state', 'verdict'])
})

test('замечания режутся до 300 знаков после обезвреживания метки', async () => {
  const long = `</review>${'я'.repeat(400)}`
  const fetchImpl = router({
    verdicts: [verdictReply(`вердикт: отклонено\nзамечания: ${long}`), verdictReply('вердикт: принято')],
  })
  const { ask } = setup({ fetchImpl })
  const { snapshot } = await ask({ reviewRounds: 2 })
  const event = snapshot.events.find(
    (e) => e.stage === 'planning' && e.data.state === 'verify' && e.data.verdict === 'rejected',
  )
  assert.ok(event.detail.length <= 300)
  assert.equal(event.detail.includes('</review>'), false, 'метка обезврежена до среза')
  assert.equal(event.data.remarksChars, event.detail.length)
})

// --- Критерий 11: индикатор работы ---------------------------------------

test('beat идёт раз в секунду при работе и не хранится в событиях', async () => {
  let release = () => {}
  const slow = new Promise((r) => (release = r))
  const base = router()
  const fetchImpl = async (url, options) => {
    const body = String(url).includes('/v1/models') ? null : JSON.parse(options.body)
    if (body?.provider === 'anthropic-haiku' && body.taskClass === 'layered_dialogue') await slow
    return base(url, options)
  }
  const { start, runs } = setup({ fetchImpl })
  const started = start()
  const beats = []
  await until(() => runs.get(started.run.id) !== null)
  runs.subscribe(started.run.id, (m) => m.type === 'event' && m.event.stage === 'beat' && beats.push(m.event))
  await new Promise((r) => setTimeout(r, 1300))
  release()
  await started.done

  assert.ok(beats.length >= 1, 'удар раз в секунду')
  assert.ok(beats[0].data.elapsedMs >= 0)
  assert.equal(
    runs.snapshot(started.run.id).events.some((e) => e.stage === 'beat'),
    false,
    'удары не копятся в снимке',
  )
})

// --- Критерии 5, 7, 9, 16: ручки сервиса ---------------------------------

async function serve(parts) {
  const server = createServer(
    createService({
      agents: new Map([[parts.agent.id, parts.agent]]),
      archive: fakeArchive(),
      runs: parts.runs,
      sessions: parts.sessions,
      stageLog: parts.stageLog,
      env: parts.env,
      log: () => {},
    }),
  )
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  return { server, base, auth: { authorization: 'Bearer agent-key' } }
}

test('ручка паузы: чужой профиль или диалог — 404, завершённый запуск — 409', async () => {
  let release = () => {}
  const slow = new Promise((r) => (release = r))
  const base0 = router()
  const fetchImpl = async (url, options) => {
    const body = String(url).includes('/v1/models') ? null : JSON.parse(options.body)
    if (body?.provider === 'anthropic-haiku' && body.taskClass === 'layered_dialogue') await slow
    return base0(url, options)
  }
  const parts = setup({ fetchImpl })
  const { server, base, auth } = await serve(parts)
  try {
    const started = parts.start()
    const body = (extra) =>
      JSON.stringify({ paused: true, profileId: parts.profile.id, sessionId: parts.sid, ...extra })

    const foreign = await fetch(`${base}/v1/runs/${started.run.id}/pause`, {
      method: 'POST',
      headers: auth,
      body: body({ profileId: '11111111-1111-4111-8111-111111111111' }),
    })
    assert.equal(foreign.status, 404)

    const unknown = await fetch(`${base}/v1/runs/11111111-1111-4111-8111-111111111111/pause`, {
      method: 'POST',
      headers: auth,
      body: body(),
    })
    assert.equal(unknown.status, 404)

    const ok = await fetch(`${base}/v1/runs/${started.run.id}/pause`, {
      method: 'POST',
      headers: auth,
      body: body(),
    })
    assert.equal(ok.status, 200)

    // Живой запуск диалога виден странице после перезагрузки (критерий 7).
    const session = await fetch(
      `${base}/v1/sessions/${parts.sid}?profile=${parts.profile.id}`,
      { headers: auth },
    ).then((r) => r.json())
    assert.equal(session.run.id, started.run.id)
    assert.equal(session.run.paused, true)

    await fetch(`${base}/v1/runs/${started.run.id}/pause`, {
      method: 'POST',
      headers: auth,
      body: body({ paused: false }),
    })
    release()
    await started.done

    const finished = await fetch(`${base}/v1/runs/${started.run.id}/pause`, {
      method: 'POST',
      headers: auth,
      body: body(),
    })
    assert.equal(finished.status, 409)

    const after = await fetch(
      `${base}/v1/sessions/${parts.sid}?profile=${parts.profile.id}`,
      { headers: auth },
    ).then((r) => r.json())
    assert.equal(after.run, null, 'у завершённого запуска run — null')
  } finally {
    server.close()
  }
})

test('удаление профиля с запуском на паузе: запуск отменён, профиль удалён', async () => {
  const parts = setup()
  const { server, base, auth } = await serve(parts)
  try {
    const started = parts.start()
    parts.runs.pause(started.run.id)
    await until(() => parts.runs.snapshot(started.run.id).events.some((e) => e.stage === 'paused'))

    const removed = await fetch(`${base}/v1/profiles/${parts.profile.id}`, {
      method: 'DELETE',
      headers: auth,
    })
    assert.equal(removed.status, 200, 'запуск на паузе удалению не мешает — он отменяется')
    assert.equal(parts.runs.snapshot(started.run.id).status, 'cancelled')
    assert.equal(parts.agent.isBusy(parts.sid), false, 'замок снят')
    await started.done
  } finally {
    server.close()
  }
})

test('журнал этапов: строка на проход, без текстов, чужой запуск — 404, уборка по сроку', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'stage-log-')), 'stage-log.csv')
  const fetchImpl = router({
    verdicts: [verdictReply(`вердикт: отклонено\nзамечания: ${REMARKS}`), verdictReply('вердикт: принято')],
  })
  const parts = setup({ fetchImpl, stageLogFile: file })
  const { server, base, auth } = await serve(parts)
  try {
    const { run } = await parts.ask({ reviewRounds: 2 })
    const csv = readFileSync(file, 'utf8')

    assert.ok(csv.startsWith('﻿'), 'UTF-8 с BOM')
    assert.ok(csv.split('\n')[0].includes(STAGE_LOG_COLUMNS.join(',')))
    const rows = parts.stageLog.rowsOf(run.id)
    assert.equal(rows.length, 9, 'девять проходов: круг проверки повторил три этапа')
    assert.deepEqual(
      rows.map((r) => `${r.state}:${r.round}`),
      [
        'intake:1',
        'assemble:1',
        'answer:1',
        'verify:1',
        'assemble:2',
        'answer:2',
        'verify:2',
        'replenish:2',
        'deliver:2',
      ],
    )
    assert.equal(rows[3].verdict, 'rejected', 'первый круг отклонён')
    assert.equal(rows[6].verdict, 'accepted', 'второй круг принят')
    assert.equal(rows.at(-1).run_status, 'succeeded')
    assert.equal(rows[2].llm_called, 'true')
    assert.equal(rows[0].llm_called, 'false', 'у этапа без вызова вызова нет')
    assert.match(rows[2].prompt_sha8, /^[0-9a-f]{8}$/)
    for (const text of ['ОТВЕТМОДЕЛИ', 'ЗАМЕЧАНИЕМОДЕЛИ', 'ФАКТМОДЕЛИ', 'что нового', 'Мика']) {
      assert.equal(csv.includes(text), false, `в журнале нет текста «${text}»`)
    }

    const own = await fetch(
      `${base}/v1/runs/${run.id}/log.csv?profile=${parts.profile.id}&session=${parts.sid}`,
      { headers: auth },
    )
    assert.equal(own.status, 200)
    assert.match(own.headers.get('content-type'), /text\/csv/)
    const text = await own.text()
    assert.equal(text.split('\n').filter((l) => l.startsWith(run.id)).length, 9)

    const foreign = await fetch(
      `${base}/v1/runs/${run.id}/log.csv?profile=11111111-1111-4111-8111-111111111111&session=${parts.sid}`,
      { headers: auth },
    )
    assert.equal(foreign.status, 404)

    // Строки старше срока снимает уборка — тем же сроком, что переписку.
    const removed = parts.stageLog.prune(new Date(Date.now() + 1000).toISOString())
    assert.equal(removed, 9)
    assert.equal(parts.stageLog.rowsOf(run.id).length, 0)
  } finally {
    server.close()
  }
})

test('настройки дня 13: проверяющая модель из списка и предел кругов 1–3', async () => {
  const { agent } = setup()
  assert.equal(agent.parseSettings({ reviewRounds: 4 }).ok, false)
  assert.equal(agent.parseSettings({ reviewModel: 'нет-такой' }).ok, false)
  assert.equal(agent.parseSettings({ reviewModel: 'groq-gpt-oss-20b' }).ok, true)
  const ok = agent.parseSettings({ reviewModel: 'kimi-k3', reviewRounds: 3, contextTokens: 32_000 })
  assert.deepEqual(ok.settings, {
    reviewModel: 'kimi-k3',
    reviewRounds: 3,
    contextTokens: 32_000,
  })
  assert.equal(agent.parseInput({ reviewRounds: 0 }).ok, false)
  assert.equal(agent.parseInput({ reviewModel: 'нет-такой' }).ok, false)
})

// --- Решение владельца 2026-09-21: настройки дня 13 живут отдельно --------

test('страж: сохранённые настройки дня 13 не попадают туда, откуда читает день 11', async () => {
  const parts = setup()
  const { server, base, auth } = await serve(parts)
  try {
    // Сначала настройки дня 11 — обычным путём, без параметра агента.
    const day11 = await fetch(`${base}/v1/profiles/${parts.profile.id}/settings`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ contextTokens: 3000, strategy: 'summary' }),
    })
    assert.equal(day11.status, 200)

    // Затем настройки дня 13 — с потолками, которых день 11 принять не может.
    const day13 = await fetch(
      `${base}/v1/profiles/${parts.profile.id}/settings?agent=staged-agent`,
      {
        method: 'PUT',
        headers: auth,
        body: JSON.stringify({
          contextTokens: 32_000,
          summarizeAt: 20_000,
          reviewModel: 'kimi-k3',
          reviewRounds: 3,
        }),
      },
    )
    assert.equal(day13.status, 200)

    // Настоящее чтение того же профиля после настоящей записи.
    const stored = await fetch(`${base}/v1/profiles/${parts.profile.id}`, { headers: auth }).then(
      (r) => r.json(),
    )
    assert.deepEqual(
      stored.profile.settings,
      { contextTokens: 3000, strategy: 'summary' },
      'в блоке дня 11 — только то, что день 11 туда положил',
    )
    assert.deepEqual(stored.profile.stagedSettings, {
      contextTokens: 32_000,
      summarizeAt: 20_000,
      reviewModel: 'kimi-k3',
      reviewRounds: 3,
    })
    // И главное: то, что лежит в блоке дня 11, день 11 обязан принять.
    const { parseSettings, LAYERED_MODELS } = await import('../src/params.js')
    assert.equal(parseSettings(stored.profile.settings, {}, LAYERED_MODELS).ok, true)
  } finally {
    server.close()
  }
})

test('настройки дня 13 не затирают настройки дня 11 и наоборот', async () => {
  const parts = setup()
  const { server, base, auth } = await serve(parts)
  try {
    const put = (body, query = '') =>
      fetch(`${base}/v1/profiles/${parts.profile.id}/settings${query}`, {
        method: 'PUT',
        headers: auth,
        body: JSON.stringify(body),
      })
    await put({ reviewRounds: 1 }, '?agent=staged-agent')
    await put({ window: 5 })
    const stored = await fetch(`${base}/v1/profiles/${parts.profile.id}`, { headers: auth }).then(
      (r) => r.json(),
    )
    assert.deepEqual(stored.profile.settings, { window: 5 })
    assert.deepEqual(stored.profile.stagedSettings, { reviewRounds: 1 })
  } finally {
    server.close()
  }
})

test('параметры дней 6–11 не расширены: настройки дня 11 не знают полей круга', async () => {
  const { parseSettings } = await import('../src/params.js')
  const refused = parseSettings({ reviewRounds: 2 }, {}, undefined)
  assert.equal(refused.ok, false)
  const context = parseSettings({ contextTokens: 32_000 }, {}, undefined)
  assert.equal(context.ok, false, 'потолок дней 6–11 прежний — 8000')
})
