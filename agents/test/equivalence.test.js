// Фаза 4а дня 11 (ADR 2026-09-15-2024, п. 12 и критерий 1): вынос общего
// кода в `shared.js` не меняет поведения `news-analyst`.
//
// Доказательство — записанный прогон: набор сценариев прогоняется через
// агента, из каждого снимаются все события монитора и все тела запросов к
// роутеру, и результат сверяется с эталоном `fixtures/news-analyst-trace.json`.
// Эталон снят на коммите ДО выноса и в коммите выноса не перезаписывается:
// если вынос сдвинул хоть одно поле события, порядок стадий, текст отказа
// или байт входа модели — сверка падает.
//
// Перезапись эталона — только сознательным `UPDATE_TRACE=1 npm test`, и
// только когда поведение меняют намеренно (это уже не фаза 4а).
//
// Требует Node 24 или флага --experimental-sqlite.

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createNewsAnalyst } from '../src/agent.js'
import { createRuns } from '../src/runs.js'
import { createSessions } from '../src/sessions.js'
import { ENV, fakeArchive, NEWS, ROUTER_ANSWER, ROUTER_MODELS } from './fixtures.js'

const here = dirname(fileURLToPath(import.meta.url))
const GOLDEN = join(here, 'fixtures', 'news-analyst-trace.json')

const SID = '55555555-5555-4555-8555-555555555555'

/** Ответ вызова памяти (сводка и факты идут одним классом `summarize`). */
const MEMO_ANSWER = {
  ok: true,
  text: 'цель: следить за финтехом\nпредпочтение: ответ списком',
  provider: { id: 'anthropic-haiku', model: 'claude-haiku-4-5', tier: 'cloud-frontier' },
  truncated: false,
  durationMs: 600,
  usage: { inputTokens: 1200, outputTokens: 300 },
}

/**
 * Часы с постоянным шагом: длительности в событиях становятся
 * воспроизводимыми, а изменение числа обращений к часам — видимым.
 */
function clock(step = 1000) {
  let t = Date.UTC(2026, 8, 16, 0, 0, 0)
  return () => (t += step)
}

/** Роутер-заглушка: отдельные ответы вызову ответа и вызову памяти. */
function router({
  answer = ROUTER_ANSWER,
  answerStatus = 200,
  memo = MEMO_ANSWER,
  memoStatus = 200,
  models = ROUTER_MODELS,
} = {}) {
  const calls = []
  const impl = async (url, options = {}) => {
    if (String(url).includes('/v1/models')) return { ok: true, status: 200, json: async () => models }
    const body = JSON.parse(options.body)
    calls.push(body)
    const isMemo = body.taskClass === 'summarize'
    const payload = isMemo ? memo : answer
    const status = isMemo ? memoStatus : answerStatus
    if (payload instanceof Error) throw payload
    return { ok: status >= 200 && status < 300, status, json: async () => payload }
  }
  impl.calls = calls
  return impl
}

/** Линейная переписка дней 7–9: без дерева и без головы. */
function seedLinear(sessions, count, tokens) {
  for (let i = 1; i <= count; i++) {
    sessions.append({
      sessionId: SID,
      role: i % 2 ? 'user' : 'agent',
      text: `реплика ${i}`,
      tokens,
    })
  }
}

/** Переписка дня 10: реплики связаны в путь, голова — на последней. */
function seedPath(sessions, count, tokens) {
  let parent = null
  for (let i = 1; i <= count; i++) {
    parent = sessions.append({
      sessionId: SID,
      role: i % 2 ? 'user' : 'agent',
      text: `реплика ${i}`,
      tokens,
      parentId: parent,
    })
  }
  sessions.setHead(SID, parent)
}

/** Один запуск до терминального события. Возвращает всё наблюдаемое снаружи. */
async function runScenario({ input, archive, fetchImpl, memory = false, seed = null, step }) {
  const now = clock(step)
  const runs = createRuns({ now })
  const sessions = memory
    ? createSessions({ file: ':memory:', ttlMs: 30 * 3600_000, log: () => {} })
    : null
  if (seed) seed(sessions)
  const agent = createNewsAnalyst({
    agent: NEWS,
    archive: archive ?? fakeArchive(),
    runs,
    sessions,
    env: ENV,
    fetchImpl,
    now,
    log: () => {},
  })
  const parsed = agent.parseInput(input)
  if (!parsed.ok) return { refused: parsed.message }
  const run = runs.create({ agent, input: parsed.input })
  agent.hold(parsed.input.sessionId)
  const messages = []
  runs.subscribe(run.id, (m) => messages.push(m))
  await agent.execute(run)
  const trace = {
    events: messages.filter((m) => m.type === 'event').map((m) => m.event),
    end: messages.find((m) => m.type === 'end') ?? null,
    calls: fetchImpl.calls,
    // Замок обязан освободиться при любом исходе.
    busyAfter: agent.isBusy(parsed.input.sessionId),
  }
  if (sessions) sessions.close()
  return trace
}

const FINTECH = { sphere: 'финтех' }

const SCENARIOS = {
  'день 6: умолчания, без сессии': () =>
    runScenario({ input: { ...FINTECH, prompt: 'что нового' }, fetchImpl: router() }),

  'день 6: свои параметры и свой системный промпт': () =>
    runScenario({
      input: {
        ...FINTECH,
        prompt: 'какие раунды',
        articles: 7,
        perSource: 2,
        maxTokens: 500,
        temperature: '0.3',
        stopSequences: ['СТОП'],
        system: 'Отвечай одним предложением и только по этим материалам.',
      },
      fetchImpl: router(),
    }),

  'запуск без темы: слова отбора из запроса': () =>
    runScenario({ input: { prompt: 'что там с платежами в Индии' }, fetchImpl: router() }),

  'пустой архив: отказ до вызова модели': () =>
    runScenario({
      input: { ...FINTECH, prompt: 'что нового' },
      archive: fakeArchive({ items: [], total: 0 }),
      fetchImpl: router(),
    }),

  'предела модели не хватает на статью': () =>
    runScenario({
      input: { ...FINTECH, model: 'groq-qwen3.6-27b', prompt: 'что нового' },
      fetchImpl: router({
        models: {
          providers: [
            {
              id: 'groq-qwen3.6-27b',
              maxRequestTokens: 5000,
              quota: { limitTokens: 7000, remainingTokens: 40, resetAt: null, stale: false },
            },
          ],
        },
      }),
    }),

  // Две ветки explainRouterError: остаток суточного лимита и «не помещается».
  'отказ роутера: суточный лимит исчерпан': () =>
    runScenario({
      input: { ...FINTECH, prompt: 'что нового' },
      fetchImpl: router({
        answerStatus: 429,
        answer: { ok: false, code: 'budget_exceeded', message: 'суточный лимит исчерпан' },
      }),
    }),

  'отказ роутера: запрос не помещается в остаток': () =>
    runScenario({
      input: { ...FINTECH, prompt: 'что нового' },
      fetchImpl: router({
        answerStatus: 429,
        answer: {
          ok: false,
          code: 'budget_exceeded',
          message: 'запрос не помещается в остаток суточного лимита',
        },
      }),
    }),

  'отказ после обращения к провайдеру': () =>
    runScenario({
      input: { ...FINTECH, prompt: 'что нового' },
      fetchImpl: router({
        answerStatus: 503,
        answer: {
          ok: false,
          code: 'all_failed',
          message: 'все провайдеры отказали',
          attempts: [{ provider: 'anthropic-haiku', outcome: 'timeout' }],
        },
      }),
    }),

  // Часы с мелким шагом: длительности уходят под секунду, и второй формат
  // `seconds` («320 мс») попадает в запись. На шаге в секунду он недостижим.
  'быстрые часы: длительности в миллисекундах': () =>
    runScenario({ input: { ...FINTECH, prompt: 'что нового' }, fetchImpl: router(), step: 10 }),

  // Ветка paidNothing по коду состояния. Список попыток обязан быть
  // непустым: роутер всегда отдаёт `attempts` массивом, и на пустом
  // решение принимает предыдущая ветка, а не диапазон 4xx.
  // 429 из исключения: провайдера звали, деньги потрачены — слот не вернуть.
  'отказ роутера: 429 после попытки провайдера': () =>
    runScenario({
      input: { ...FINTECH, prompt: 'что нового' },
      fetchImpl: router({
        answerStatus: 429,
        answer: {
          ok: false,
          code: 'rate_limited',
          message: 'слишком часто',
          attempts: [{ provider: 'anthropic-haiku', outcome: 'rate_limited' }],
        },
      }),
    }),

  // 400 внутри диапазона: отказ разбора, провайдер не отвечал — слот вернуть.
  'отказ роутера: 400 разбора запроса': () =>
    runScenario({
      input: { ...FINTECH, prompt: 'что нового' },
      fetchImpl: router({
        answerStatus: 400,
        answer: {
          ok: false,
          code: 'bad_input',
          message: 'неверный запрос',
          attempts: [{ provider: 'anthropic-haiku', outcome: 'refused' }],
        },
      }),
    }),

  'сетевая ошибка роутера': () =>
    runScenario({
      input: { ...FINTECH, prompt: 'что нового' },
      fetchImpl: router({ answer: new TypeError('fetch failed') }),
    }),

  'обрезанный ответ, чужие ссылки и ленты без ответа': () =>
    runScenario({
      input: { ...FINTECH, prompt: 'что нового' },
      archive: fakeArchive({
        refresh: {
          attempted: true,
          refreshed: true,
          added: 3,
          dropped: 0,
          failed: [{ source: 'Pandaily', reason: 'таймаут' }],
        },
      }),
      fetchImpl: router({ answer: { ...ROUTER_ANSWER, truncated: true } }),
    }),

  'сводка: сжатие истории': () =>
    runScenario({
      input: { ...FINTECH, prompt: 'дальше', sessionId: SID, summarizeAt: 500, contextTokens: 8000 },
      memory: true,
      seed: (s) => seedLinear(s, 6, 200),
      fetchImpl: router(),
    }),

  'сводка: отказ вызова сжатия': () =>
    runScenario({
      input: { ...FINTECH, prompt: 'дальше', sessionId: SID, summarizeAt: 500, contextTokens: 8000 },
      memory: true,
      seed: (s) => seedLinear(s, 6, 200),
      fetchImpl: router({
        memoStatus: 502,
        memo: {
          ok: false,
          code: 'provider_error',
          message: 'провайдер не ответил',
          attempts: [{ provider: 'anthropic-haiku', outcome: 'error' }],
        },
      }),
    }),

  'сводка: исходник сверх потолка усечён': () =>
    runScenario({
      input: { ...FINTECH, prompt: 'дальше', sessionId: SID, summarizeAt: 500, contextTokens: 8000 },
      memory: true,
      seed: (s) => seedLinear(s, 20, 4096),
      fetchImpl: router(),
    }),

  'факты: обновление после ответа': () =>
    runScenario({
      input: {
        ...FINTECH,
        prompt: 'что нового',
        sessionId: SID,
        strategy: 'facts',
        window: 4,
        factsTokens: 600,
      },
      memory: true,
      seed: (s) => seedPath(s, 4, 100),
      fetchImpl: router(),
    }),

  'факты: обрезанный выход отброшен': () =>
    runScenario({
      input: {
        ...FINTECH,
        prompt: 'что нового',
        sessionId: SID,
        strategy: 'facts',
        factsTokens: 200,
      },
      memory: true,
      seed: (s) => seedPath(s, 4, 100),
      fetchImpl: router({ memo: { ...MEMO_ANSWER, truncated: true } }),
    }),

  'факты: отказ вызова': () =>
    runScenario({
      input: { ...FINTECH, prompt: 'что нового', sessionId: SID, strategy: 'facts' },
      memory: true,
      seed: (s) => seedPath(s, 4, 100),
      fetchImpl: router({
        memoStatus: 502,
        memo: {
          ok: false,
          code: 'provider_error',
          message: 'провайдер не ответил',
          attempts: [{ provider: 'anthropic-haiku', outcome: 'error' }],
        },
      }),
    }),

  'факты: исходник сверх потолка усечён': () =>
    runScenario({
      input: {
        ...FINTECH,
        prompt: 'что нового',
        sessionId: SID,
        strategy: 'facts',
        window: 40,
        factsTokens: 600,
      },
      memory: true,
      seed: (s) => seedPath(s, 40, 4096),
      fetchImpl: router(),
    }),

  'окно: последние M реплик пути': () =>
    runScenario({
      input: { ...FINTECH, prompt: 'что нового', sessionId: SID, strategy: 'window', window: 2 },
      memory: true,
      seed: (s) => seedPath(s, 6, 100),
      fetchImpl: router(),
    }),

  'ветки: путь от корня до головы': () =>
    runScenario({
      input: {
        ...FINTECH,
        prompt: 'что нового',
        sessionId: SID,
        strategy: 'branches',
        contextTokens: 3000,
      },
      memory: true,
      seed: (s) => seedPath(s, 4, 100),
      fetchImpl: router(),
    }),

  // Замок сессии: занятие, отказ второму запуску и освобождение после запуска.
  'замок сессии: занят, отказ второму, освобождён после': async () => {
    const now = clock()
    const runs = createRuns({ now })
    const sessions = createSessions({ file: ':memory:', ttlMs: 30 * 3600_000, log: () => {} })
    const agent = createNewsAnalyst({
      agent: NEWS,
      archive: fakeArchive(),
      runs,
      sessions,
      env: ENV,
      fetchImpl: router(),
      now,
      log: () => {},
    })
    const input = { ...FINTECH, prompt: 'что нового', sessionId: SID }
    const before = agent.isBusy(SID)
    const parsed = agent.parseInput(input)
    agent.hold(SID)
    const held = agent.isBusy(SID)
    const second = agent.parseInput(input)
    const run = runs.create({ agent, input: parsed.input })
    await agent.execute(run)
    const after = agent.isBusy(SID)
    sessions.close()
    return {
      before,
      held,
      secondRefused: second.ok === false,
      secondMessage: second.message ?? null,
      after,
      // Замок только для своей сессии: чужая не занята.
      otherBusy: agent.isBusy('66666666-6666-4666-8666-666666666666'),
      nullBusy: agent.isBusy(null),
    }
  },
}

/**
 * Приводит запись к сравнимому виду: случайные идентификаторы (запуск,
 * событие, вызов инструмента) заменяются на устойчивые метки в порядке
 * появления, ключи объектов сортируются. Всё остальное — включая длительности
 * на постоянных часах — сравнивается как есть.
 */
function normalize(value) {
  const seen = new Map()
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  const walk = (v) => {
    if (typeof v === 'string') {
      if (!uuid.test(v)) return v
      if (!seen.has(v)) seen.set(v, `uuid-${seen.size + 1}`)
      return seen.get(v)
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out = {}
      for (const key of Object.keys(v).sort()) out[key] = walk(v[key])
      return out
    }
    return v
  }
  return walk(value)
}

test('news-analyst: события и запросы к модели совпадают с записанным прогоном', async () => {
  const actual = {}
  for (const [name, run] of Object.entries(SCENARIOS)) actual[name] = normalize(await run())

  if (process.env.UPDATE_TRACE === '1') {
    mkdirSync(dirname(GOLDEN), { recursive: true })
    writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`)
  }

  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'))
  assert.deepEqual(
    Object.keys(golden).sort(),
    Object.keys(SCENARIOS).sort(),
    'эталон снят не с того набора сценариев',
  )
  for (const name of Object.keys(SCENARIOS)) {
    assert.deepEqual(actual[name], golden[name], `расхождение в сценарии «${name}»`)
  }
})

test('эталон не пуст и правда проходит по вынесенному коду', () => {
  // Без этой проверки пустой или выродившийся эталон совпадал бы сам с собой.
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'))
  const dump = JSON.stringify(golden)
  const events = Object.values(golden).reduce((sum, s) => sum + (s.events?.length ?? 0), 0)
  assert.ok(events > 100, `в эталоне всего ${events} событий`)

  // Обе ветки explainRouterError.
  assert.match(dump, /Суточный лимит расхода приложения исчерпан/)
  assert.match(dump, /Запрос слишком большой для остатка суточного лимита/)
  assert.match(dump, /Модель не ответила/)
  // Замок сессии.
  assert.match(dump, /Дождитесь ответа на предыдущее сообщение/)
  // Оба вызова памяти через askSummary и оба усечения через fitDialog.
  assert.match(dump, /Сжал историю/)
  assert.match(dump, /Обновил факты/)
  assert.match(dump, /Старые реплики не вошли в сводку/)
  assert.match(dump, /Старые реплики не вошли в факты/)
  // Оба формата длительности (seconds): секунды и миллисекунды.
  assert.match(dump, /\d+\.\d+ с/)
  assert.match(dump, /\d+ мс/)
  // Обе ветки paidNothing по коду состояния.
  assert.match(dump, /rate_limited/)
  assert.match(dump, /bad_input/)
})
