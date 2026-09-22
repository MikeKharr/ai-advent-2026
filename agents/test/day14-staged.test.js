// День 14: инварианты профиля на машине состояний дня 13
// (ADR 2026-09-22-0827, критерии 1, 4–10).
// Требует Node 24 или флага --experimental-sqlite.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createInvariants } from '../src/invariants.js'
import { promptSha8 } from '../src/llm.js'
import { loadRegistry } from '../src/registry.js'
import { createRuns } from '../src/runs.js'
import { createSessions } from '../src/sessions.js'
import { createStagedAgent, STAGES } from '../src/staged.js'
import { ENV } from './fixtures.js'

const here = dirname(fileURLToPath(import.meta.url))
const REGISTRY = loadRegistry(
  JSON.parse(readFileSync(join(here, '..', 'config', 'agents.json'), 'utf8')),
)

const ANSWER_TEXT = 'ОТВЕТМОДЕЛИ про раунды финтеха'

const answerReply = (text = ANSWER_TEXT) => ({
  ok: true,
  text,
  provider: { id: 'anthropic-haiku', model: 'claude-haiku-4-5', tier: 'cloud-frontier' },
  truncated: false,
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
  text: 'тема: продолжить',
  provider: { id: 'anthropic-haiku', model: 'claude-haiku-4-5', tier: 'cloud-frontier' },
  truncated: false,
  durationMs: 90,
  usage: { inputTokens: 400, outputTokens: 30 },
}

function router({ answers = [answerReply()], verdicts = [verdictReply('вердикт: принято\nзамечания:')] } = {}) {
  const calls = []
  let answerNo = 0
  let verdictNo = 0
  const impl = async (url, options = {}) => {
    if (String(url).includes('/v1/models'))
      return { ok: true, status: 200, json: async () => ({ providers: [] }) }
    const body = JSON.parse(options.body)
    calls.push(body)
    if (body.taskClass === 'summarize') return { ok: true, status: 200, json: async () => deltaReply }
    if (body.provider === 'kimi-k2.6') {
      return { ok: true, status: 200, json: async () => verdicts[Math.min(verdictNo++, verdicts.length - 1)] }
    }
    return { ok: true, status: 200, json: async () => answers[Math.min(answerNo++, answers.length - 1)] }
  }
  impl.calls = calls
  impl.answers = () => calls.filter((c) => c.taskClass === 'layered_dialogue' && c.provider !== 'kimi-k2.6')
  impl.verdicts = () => calls.filter((c) => c.provider === 'kimi-k2.6')
  impl.replenish = () => calls.filter((c) => c.taskClass === 'summarize')
  return impl
}

/** Агент дня 14: та же машина со швом `invariants`. */
function setup({ fetchImpl = router(), agentId = 'invariant-agent' } = {}) {
  const env = { ...ENV, PAUSE_TTL_MINUTES: 60 }
  const sessions = createSessions({
    file: ':memory:',
    ttlMs: env.SESSION_TTL_HOURS * 3600_000,
    profileTtlMs: env.PROFILE_TTL_DAYS * 24 * 3600_000,
    log: () => {},
  })
  const runs = createRuns()
  const agent = createStagedAgent({
    agent: REGISTRY.get(agentId),
    runs,
    sessions,
    env,
    fetchImpl,
    log: () => {},
    invariants: agentId === 'invariant-agent' ? createInvariants({ sessions }) : null,
  })
  const profile = sessions.createProfile({ name: 'Мика' }).profile
  const sid = sessions.createSession({ profileId: profile.id }).id
  const ask = async (body = {}) => {
    const parsed = agent.parseInput({
      profileId: profile.id,
      sessionId: sid,
      prompt: 'что нового',
      reviewRounds: 2,
      ...body,
    })
    assert.equal(parsed.ok, true, parsed.message)
    const run = runs.create({ agent, input: parsed.input })
    agent.hold(parsed.input.sessionId)
    await agent.execute(run)
    return { run, snapshot: runs.snapshot(run.id) }
  }
  const add = (text) => sessions.addInvariant({ profileId: profile.id, text })
  return { env, sessions, runs, agent, fetchImpl, profile, sid, ask, add }
}

const stageEvents = (snapshot) => snapshot.events.filter((e) => e.stage === 'state')
const planning = (snapshot) => snapshot.events.filter((e) => e.stage === 'planning')

// --- Критерий 1: день 13 не тронут ---------------------------------------

test('промпты дня 13 не сдвинулись: sha8 четырёх этапов прежние', async () => {
  const { agent } = setup({ agentId: 'staged-agent' })
  const described = await agent.describe()
  const sha = Object.fromEntries(
    described.stages.filter((s) => s.prompt).map((s) => [s.id, promptSha8(s.prompt)]),
  )
  assert.deepEqual(sha, {
    assemble: '26b5d8d8',
    answer: '5afe6550',
    verify: '546b265d',
    replenish: '584d8097',
  })
  assert.equal(described.invariants, undefined, 'у агента дня 13 раздела инвариантов нет')
})

test('день 13 идёт прежним ходом: те же этапы, те же промпты вызовов', async () => {
  const thirteen = setup({ agentId: 'staged-agent' })
  const fourteen = setup()
  const a = await thirteen.ask()
  const b = await fourteen.ask()

  assert.equal(a.snapshot.status, 'succeeded')
  assert.equal(b.snapshot.status, 'succeeded')
  // Этапы и их порядок у дня 13 прежние, и ни одно его событие не говорит
  // об инвариантах: шов их не трогает.
  assert.deepEqual(
    stageEvents(a.snapshot).map((e) => e.data.state),
    STAGES.map((s) => s.id),
  )
  assert.equal(
    a.snapshot.events.filter((e) => JSON.stringify(e).includes('нвариант')).length,
    0,
  )
  const prompts = (snapshot) =>
    snapshot.events.filter((e) => e.stage === 'llm_call').map((e) => `${e.data.promptId}:${e.data.promptSha}`)
  const thirteenPrompts = prompts(a.snapshot)
  const fourteenPrompts = prompts(b.snapshot)
  assert.deepEqual(thirteenPrompts, ['stage.answer:5afe6550', 'stage.verify:546b265d', 'stage.replenish:584d8097'])
  // У дня 14 свой системный промпт записи реестра и свой промпт проверки;
  // промпт пополнения — общий, и его `sha8` от шва не зависит.
  assert.deepEqual(
    fourteenPrompts.map((p) => p.split(':')[0]),
    ['stage.answer', 'stage.verify.invariants', 'stage.replenish'],
  )
  assert.equal(fourteenPrompts[2], 'stage.replenish:584d8097')
  assert.notEqual(fourteenPrompts[0], 'stage.answer:5afe6550')
  assert.match(fourteenPrompts[1], /^stage\.verify\.invariants:[0-9a-f]{8}$/)
  assert.notEqual(fourteenPrompts[1].split(':')[1], '546b265d')
})

// --- Критерий 4: пустой список не стоит ни токена -------------------------

test('запуск без инвариантов: ни одного блока <invariants> и «нет» в приёме', async () => {
  const fetchImpl = router()
  const { ask } = setup({ fetchImpl })
  const { snapshot } = await ask()

  for (const call of fetchImpl.calls) {
    // Сверяется вход запроса: метка в системном промпте записи реестра —
    // это объяснение агенту, а не блок данных, и она там при любом профиле.
    assert.ok(!String(call.input ?? '').includes('<invariants>'), 'блока нет ни в одном запросе')
  }
  const intake = planning(snapshot).find((e) => e.title.startsWith('Инварианты профиля'))
  assert.equal(intake.title, 'Инварианты профиля: нет')
  assert.deepEqual(intake.data.invariants, [])
})

// --- Критерий 5: блок первым в трёх запросах ------------------------------

test('запуск с инвариантами: блок первым в ответе, проверке и пополнении', async () => {
  const fetchImpl = router()
  const { ask, add } = setup({ fetchImpl })
  add('Отвечай не длиннее пяти предложений')
  add('Никогда не выдумывай ссылки')
  const { snapshot } = await ask()

  const answer = fetchImpl.answers()[0]
  assert.ok(answer.input.startsWith('Инварианты профиля —'), 'блок идёт первым в запросе ответа')
  assert.ok(answer.input.indexOf('<invariants>') < answer.input.indexOf('<request>'))
  assert.match(answer.input, /П1 — Отвечай не длиннее пяти предложений/)

  const verdict = fetchImpl.verdicts()[0]
  assert.ok(verdict.input.startsWith('Инварианты профиля —'))
  assert.match(verdict.system, /инварианты: соблюдены \| нарушены/)

  const replenish = fetchImpl.replenish().at(-1)
  assert.ok(replenish.input.startsWith('Инварианты профиля —'))
  assert.match(replenish.input, /не записывай/)

  const intake = planning(snapshot).find((e) => e.title.startsWith('Инварианты профиля'))
  assert.match(intake.title, /^Инварианты профиля: П1, П2 — 2 из 10, ~\d+ токенов$/)
})

// --- Критерии 6 и 8: возврат и ответ, который не отдан --------------------

test('нарушение на непоследнем круге возвращает на сборку с названным номером', async () => {
  const fetchImpl = router({
    verdicts: [
      verdictReply('вердикт: отклонено\nзамечания: слишком длинно\nинварианты: нарушены П1'),
      verdictReply('вердикт: принято\nзамечания:\nинварианты: соблюдены'),
    ],
  })
  const { ask, add } = setup({ fetchImpl })
  add('Отвечай не длиннее пяти предложений')
  const { snapshot } = await ask({ reviewRounds: 2 })

  assert.equal(snapshot.status, 'succeeded')
  assert.equal(snapshot.result.answer, ANSWER_TEXT)
  const second = fetchImpl.answers()[1]
  assert.ok(second, 'второй запрос ответа состоялся')
  assert.match(second.input, /Нарушен инвариант профиля П1 — Отвечай не длиннее пяти предложений/)
  assert.equal(
    stageEvents(snapshot).filter((e) => e.data.state === 'assemble').length,
    2,
    'машина вернулась на сборку',
  )
  assert.deepEqual(snapshot.result.summary.invariants, { checked: [1], status: 'held' })
})

test('нарушение на последнем круге: ответ не отдан, пополнения нет', async () => {
  const fetchImpl = router({
    verdicts: [
      verdictReply('вердикт: отклонено\nзамечания: слишком длинно\nинварианты: нарушены П1'),
      verdictReply('вердикт: отклонено\nзамечания: всё ещё длинно\nинварианты: нарушены П1'),
    ],
  })
  const { ask, add, sessions, sid } = setup({ fetchImpl })
  add('Отвечай не длиннее пяти предложений')
  const { snapshot } = await ask({ reviewRounds: 2 })

  assert.equal(snapshot.status, 'succeeded')
  assert.equal(snapshot.result.answer, null)
  assert.deepEqual(snapshot.result.withheld.invariants, [1])
  assert.equal(snapshot.result.withheld.round, 2)
  assert.equal(snapshot.result.withheld.rounds, 2)

  // После второго вердикта к роутеру не уходит ничего: пополнение пропущено.
  const afterVerdict = fetchImpl.calls.slice(fetchImpl.calls.lastIndexOf(fetchImpl.verdicts()[1]) + 1)
  assert.deepEqual(afterVerdict, [])

  // В переписке — объяснение с номером, текстом и кругом; ответа нет нигде.
  const history = sessions.history(sid)
  const texts = history.map((m) => m.text)
  assert.ok(!texts.includes(ANSWER_TEXT), 'оплаченный ответ в переписку не попал')
  const last = history.at(-1)
  assert.match(last.text, /^Ответ не отдан: нарушает инвариант профиля П1 «Отвечай не длиннее пяти предложений» \(круг 2 из 2\)/)
  assert.match(last.text, /Замечания проверки: всё ещё длинно/)
  const meta = typeof last.meta === 'string' ? JSON.parse(last.meta) : last.meta
  assert.deepEqual(meta.withheld, { invariants: [1], round: 2, rounds: 2 })

  const done = snapshot.events.at(-1)
  assert.equal(done.title, 'Ответ не отдан: нарушен инвариант профиля')
})

test('предел 1 и нарушение — «не отдан» сразу, без второго вызова ответа', async () => {
  const fetchImpl = router({
    verdicts: [verdictReply('вердикт: отклонено\nзамечания: нет\nинварианты: нарушены П1')],
  })
  const { ask, add } = setup({ fetchImpl })
  add('Отвечай не длиннее пяти предложений')
  const { snapshot } = await ask({ reviewRounds: 1 })

  assert.equal(snapshot.result.answer, null)
  assert.equal(fetchImpl.answers().length, 1)
  assert.equal(snapshot.result.rounds, 1)
})

// --- Критерий 7: сила третьей строки и её отсутствие ----------------------

test('«принято» вместе с «нарушены П1» читается как нарушение', async () => {
  const fetchImpl = router({
    verdicts: [verdictReply('вердикт: принято\nзамечания:\nинварианты: нарушены П1')],
  })
  const { ask, add } = setup({ fetchImpl })
  add('Отвечай не длиннее пяти предложений')
  const { snapshot } = await ask({ reviewRounds: 1 })

  assert.equal(snapshot.result.answer, null, 'инвариант сильнее строки «вердикт»')
  const clash = planning(snapshot).find((e) => e.title.includes('вместе с названным нарушением'))
  assert.ok(clash, 'противоречие названо в мониторе')
})

test('«нарушены» без годных номеров — обычное отклонение, а не «не отдан»', async () => {
  const fetchImpl = router({
    verdicts: [verdictReply('вердикт: отклонено\nзамечания: по существу\nинварианты: нарушены П9')],
  })
  const { ask, add } = setup({ fetchImpl })
  add('Отвечай не длиннее пяти предложений')
  const { snapshot } = await ask({ reviewRounds: 1 })

  assert.equal(snapshot.result.answer, ANSWER_TEXT)
  assert.equal(snapshot.result.review.verdict, 'rejected')
  assert.equal(snapshot.result.summary.invariants.status, 'unchecked')
})

test('статус инвариантов — по последнему кругу, а не по первому', async () => {
  // Круг 1 сказал «соблюдены» и отклонил ответ; круг 2 третьей строки не дал.
  // Отдаётся ответ круга 2, и пометка обязана говорить о НЁМ (находка
  // reviewer к PR #200: статус копился и врал про непроверенный ответ).
  const fetchImpl = router({
    verdicts: [
      verdictReply('вердикт: отклонено\nзамечания: коротко\nинварианты: соблюдены'),
      verdictReply('вердикт: принято\nзамечания:'),
    ],
  })
  const { ask, add } = setup({ fetchImpl })
  add('Отвечай не длиннее пяти предложений')
  const { snapshot } = await ask({ reviewRounds: 2 })

  assert.equal(snapshot.result.answer, ANSWER_TEXT)
  assert.equal(fetchImpl.verdicts().length, 2, 'кругов было два')
  assert.deepEqual(snapshot.result.summary.invariants, { checked: [1], status: 'unchecked' })
})

test('без третьей строки статус инвариантов у сообщения — unchecked', async () => {
  const fetchImpl = router({ verdicts: [verdictReply('вердикт: принято\nзамечания:')] })
  const { ask, add } = setup({ fetchImpl })
  add('Отвечай не длиннее пяти предложений')
  const { snapshot } = await ask({ reviewRounds: 1 })

  assert.equal(snapshot.result.answer, ANSWER_TEXT)
  assert.deepEqual(snapshot.result.summary.invariants, { checked: [1], status: 'unchecked' })
})

// --- Критерий 10: профиль дня 13 инвариантов не видит ---------------------

test('тот же профиль в дне 13 отвечает без блока инвариантов', async () => {
  const fetchImpl = router()
  // Профиль у дней 13 и 14 общий: инварианты заводятся тем же хранилищем, а
  // видеть их должен только `invariant-agent` (ADR 2026-09-22-0827, п. 2).
  const { sessions, profile, ask } = setup({ agentId: 'staged-agent', fetchImpl })
  sessions.addInvariant({ profileId: profile.id, text: 'Отвечай коротко' })
  assert.equal(sessions.invariantsOf(profile.id).length, 1, 'инвариант в профиле есть')

  const { snapshot } = await ask({ reviewRounds: 1 })
  assert.equal(snapshot.status, 'succeeded')

  // Запуск действительно состоялся: без этой проверки цикл ниже делал бы ноль
  // итераций и тест был бы зелёным всегда (находка reviewer к PR #200).
  assert.ok(fetchImpl.calls.length > 0, 'запросы к роутеру были')
  assert.ok(fetchImpl.answers().length > 0, 'вызов ответа состоялся')
  for (const call of fetchImpl.calls) {
    assert.ok(!String(call.input ?? '').includes('<invariants>'), 'блока нет ни в одном запросе')
  }
  // И ни слова об инвариантах в событиях сданного дня.
  assert.equal(
    snapshot.events.filter((e) => JSON.stringify(e).includes('нвариант')).length,
    0,
  )
})

// --- Журнал этапов: verify violated, replenish skipped --------------------

test('этап проверки называет вердикт violated, пополнение — skipped', async () => {
  const rows = []
  const fetchImpl = router({
    verdicts: [verdictReply('вердикт: отклонено\nзамечания: нет\nинварианты: нарушены П1')],
  })
  const env = { ...ENV, PAUSE_TTL_MINUTES: 60 }
  const sessions = createSessions({
    file: ':memory:',
    ttlMs: env.SESSION_TTL_HOURS * 3600_000,
    profileTtlMs: env.PROFILE_TTL_DAYS * 24 * 3600_000,
    log: () => {},
  })
  const runs = createRuns()
  const agent = createStagedAgent({
    agent: REGISTRY.get('invariant-agent'),
    runs,
    sessions,
    stageLog: { append: (batch) => rows.push(...batch) },
    env,
    fetchImpl,
    log: () => {},
    invariants: createInvariants({ sessions }),
  })
  const profile = sessions.createProfile({ name: 'Мика' }).profile
  sessions.addInvariant({ profileId: profile.id, text: 'Отвечай коротко' })
  const sid = sessions.createSession({ profileId: profile.id }).id
  const parsed = agent.parseInput({ profileId: profile.id, sessionId: sid, prompt: 'что', reviewRounds: 1 })
  const run = runs.create({ agent, input: parsed.input })
  agent.hold(sid)
  await agent.execute(run)

  const byState = Object.fromEntries(rows.map((r) => [r.state, r]))
  assert.equal(byState.verify.verdict, 'violated')
  assert.equal(byState.replenish.outcome, 'skipped')
  assert.equal(byState.replenish.llm_called, 'false')
  assert.deepEqual(
    rows.map((r) => r.state),
    STAGES.map((s) => s.id),
  )
})
