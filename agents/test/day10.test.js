// День 10: скользящее окно и ветки диалога (ADR 2026-09-14-0447).
// Критерии приёмки 1 (совместимость), 2 (окно) и 4 (ветки), включая
// проверку принадлежности сообщения сессии в `PUT …/head`.
// Требует Node 24 или флага --experimental-sqlite.

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { createNewsAnalyst } from '../src/agent.js'
import { createRuns } from '../src/runs.js'
import { createService } from '../src/service.js'
import { createSessions } from '../src/sessions.js'
import { ENV, fakeArchive, fakeRouter, NEWS } from './fixtures.js'

const SID = '11111111-1111-4111-8111-111111111111'
/** Вторая сессия в той же базе: номера сообщений сквозные. */
const OTHER = '22222222-2222-4222-8222-222222222222'

function setup() {
  const sessions = createSessions({ file: ':memory:', ttlMs: 30 * 3600_000, log: () => {} })
  const runs = createRuns()
  const fetchImpl = fakeRouter()
  const agent = createNewsAnalyst({
    agent: NEWS,
    archive: fakeArchive(),
    runs,
    sessions,
    env: ENV,
    fetchImpl,
    log: () => {},
  })
  const ask = async (body) => {
    const parsed = agent.parseInput({ sessionId: SID, ...body })
    if (!parsed.ok) return { refused: parsed.message }
    const run = runs.create({ agent, input: parsed.input })
    agent.hold(parsed.input.sessionId)
    await agent.execute(run)
    return { run, snapshot: runs.snapshot(run.id) }
  }
  return { agent, runs, sessions, fetchImpl, ask }
}

/** Сервис поверх того же хранилища — для `GET` и `PUT …/head`. */
async function serve({ agent, runs, sessions }) {
  const agents = new Map([[agent.id, agent]])
  const server = createServer(
    createService({ agents, archive: fakeArchive(), runs, sessions, env: ENV, log: () => {} }),
  )
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const auth = { authorization: 'Bearer agent-key' }
  return {
    base,
    get: (path) => fetch(`${base}${path}`, { headers: auth }),
    putHead: (sessionId, body) =>
      fetch(`${base}/v1/sessions/${sessionId}/head`, {
        method: 'PUT',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** Сколько реплик в блоке `<dialog>` запроса к модели. */
function dialogLines(input) {
  const block = input.match(/<dialog>\n([\s\S]*?)\n<\/dialog>/)
  return block ? block[1].split('\n\n') : []
}

// --- Критерий 1: без стратегии поведение прежнее ------------------------

test('без стратегии дерево не ведётся: parent_id и head остаются пустыми', async () => {
  const ctx = setup()
  await ctx.ask({ sphere: 'финтех', prompt: 'что нового' })
  await ctx.ask({ sphere: 'финтех', prompt: 'а подробнее' })

  assert.deepEqual(
    ctx.sessions.history(SID).map((m) => m.parentId),
    [null, null, null, null],
    'сессии дней 6–9 линейны',
  )
  assert.equal(ctx.sessions.head(SID), null)

  const http = await serve(ctx)
  const body = await (await http.get(`/v1/sessions/${SID}`)).json()
  // Без параметров ответ прежний: счётчик дней 7–9, без willCompress.
  assert.deepEqual(Object.keys(body.context).sort(), ['freshTokens', 'summaryTokens', 'total'])
  assert.equal(body.head, null)
  await http.close()
})

test('миграция идемпотентна: столбцы добавляются один раз', () => {
  const first = setup()
  first.sessions.append({ sessionId: SID, role: 'user', text: 'привет', tokens: 5 })
  // Повторное открытие той же базы не должно падать на ALTER TABLE.
  const again = createSessions({ file: ':memory:', ttlMs: 3600_000, log: () => {} })
  assert.equal(first.sessions.history(SID)[0].parentId, null, 'старая строка получает NULL')
  again.close()
})

// --- Критерий 2: скользящее окно ---------------------------------------

test('окно отдаёт ровно последние M реплик пути, без блока памяти', async () => {
  const { ask, fetchImpl } = setup()
  const run = { sphere: 'финтех', strategy: 'window', window: 2, contextTokens: 0 }
  await ask({ ...run, prompt: 'первый вопрос' })
  await ask({ ...run, prompt: 'второй вопрос' })
  await ask({ ...run, prompt: 'третий вопрос' })

  const third = fetchImpl.calls[2].body.input
  assert.equal(dialogLines(third).length, 2, 'ровно M реплик, хотя в базе четыре')
  assert.match(third, /Пользователь: второй вопрос/)
  assert.doesNotMatch(third, /первый вопрос/, 'реплики старше окна не уходят модели')
  assert.doesNotMatch(third, /<summary>/, 'блока памяти у окна нет')
  assert.match(third, /третий вопрос/, 'текущий вопрос — отдельно от истории')
})

test('нулевой contextTokens не выключает окно: порога в токенах у него нет', async () => {
  const { ask, fetchImpl } = setup()
  await ask({ sphere: 'финтех', strategy: 'window', window: 10, contextTokens: 0, prompt: 'раз' })
  const second = await ask({
    sphere: 'финтех',
    strategy: 'window',
    window: 10,
    contextTokens: 0,
    prompt: 'два',
  })
  assert.match(fetchImpl.calls[1].body.input, /Пользователь: раз/)
  assert.equal(second.snapshot.result.context.effective, null, 'окна в токенах нет')
  assert.equal(second.snapshot.result.context.windowSize, 10)
})

test('при M больше числа реплик уходят все, что есть', async () => {
  const { ask, fetchImpl } = setup()
  await ask({ sphere: 'финтех', strategy: 'window', window: 40, prompt: 'раз' })
  await ask({ sphere: 'финтех', strategy: 'window', window: 40, prompt: 'два' })
  assert.equal(dialogLines(fetchImpl.calls[1].body.input).length, 2)
})

// --- Критерий 4: ветки --------------------------------------------------

test('запуск с parentId рождает сестринскую ветку, голова — на новом ответе', async () => {
  const ctx = setup()
  const branches = { sphere: 'финтех', strategy: 'branches', contextTokens: 3000 }
  await ctx.ask({ ...branches, prompt: 'вопрос А' })
  const firstAnswer = ctx.sessions.head(SID)
  await ctx.ask({ ...branches, prompt: 'вопрос Б' })
  assert.notEqual(ctx.sessions.head(SID), firstAnswer, 'голова ушла вниз по ветке')

  // Сестра «вопроса Б»: тот же родитель — ответ на «вопрос А».
  const { snapshot } = await ctx.ask({ ...branches, prompt: 'вопрос В', parentId: firstAnswer })
  const nodes = ctx.sessions.history(SID)
  const asked = nodes.find((m) => m.text === 'вопрос В')
  assert.equal(asked.parentId, firstAnswer, 'вопрос сел под указанный ответ')
  assert.equal(ctx.sessions.head(SID), nodes.at(-1).id, 'голова — на новом ответе')
  assert.equal(snapshot.result.context.pathMessages, 2, 'в пути только ветка А')

  const input = ctx.fetchImpl.calls[2].body.input
  assert.match(input, /Пользователь: вопрос А/)
  assert.doesNotMatch(input, /вопрос Б/, 'реплики другой ветки модели не видны')
})

test('PUT …/head переводит голову на самый поздний лист поддерева', async () => {
  const ctx = setup()
  const branches = { sphere: 'финтех', strategy: 'branches', contextTokens: 3000 }
  await ctx.ask({ ...branches, prompt: 'вопрос А' })
  const firstAnswer = ctx.sessions.head(SID)
  await ctx.ask({ ...branches, prompt: 'вопрос Б' })
  const tailOfB = ctx.sessions.head(SID)
  await ctx.ask({ ...branches, prompt: 'вопрос В', parentId: firstAnswer })

  const http = await serve(ctx)
  const askedB = ctx.sessions.history(SID).find((m) => m.text === 'вопрос Б')
  const response = await http.putHead(SID, { messageId: askedB.id })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).head, tailOfB, 'ветка грузится со своим хвостом')

  const body = await (await http.get(`/v1/sessions/${SID}`)).json()
  assert.equal(body.head, tailOfB)
  assert.ok(
    body.messages.every((m) => 'parentId' in m),
    'GET отдаёт все узлы с parentId',
  )
  await http.close()
})

test('PUT …/head с сообщением другой сессии — 404, голова на месте', async () => {
  const ctx = setup()
  const branches = { sphere: 'финтех', strategy: 'branches', contextTokens: 3000 }
  await ctx.ask({ ...branches, prompt: 'вопрос А' })
  const head = ctx.sessions.head(SID)
  // Чужая переписка в той же базе: номера сообщений идут сквозной нумерацией.
  const foreign = ctx.sessions.append({
    sessionId: OTHER,
    role: 'agent',
    text: 'чужая переписка',
    tokens: 10,
  })

  const http = await serve(ctx)
  const response = await http.putHead(SID, { messageId: foreign })
  assert.equal(response.status, 404)
  assert.equal((await response.json()).code, 'unknown_message')
  assert.equal(ctx.sessions.head(SID), head, 'голова не сдвинулась')

  // И чужой узел не попадает ни в путь, ни в ответ GET.
  assert.equal(
    ctx.sessions.path(SID).some((m) => m.text === 'чужая переписка'),
    false,
  )
  const body = await (await http.get(`/v1/sessions/${SID}`)).json()
  assert.equal(
    body.messages.some((m) => m.text === 'чужая переписка'),
    false,
  )
  await http.close()

  // Несуществующий номер — тот же отказ.
  const http2 = await serve(ctx)
  const missing = await http2.putHead(SID, { messageId: 9999 })
  assert.equal(missing.status, 404)
  await http2.close()
})

test('PUT …/head во время запуска сессии — 409, голова не двигается', async () => {
  const ctx = setup()
  const branches = { sphere: 'финтех', strategy: 'branches', contextTokens: 3000 }
  await ctx.ask({ ...branches, prompt: 'вопрос А' })
  const head = ctx.sessions.head(SID)
  const first = ctx.sessions.history(SID)[0]

  ctx.agent.hold(SID)
  const http = await serve(ctx)
  const response = await http.putHead(SID, { messageId: first.id })
  assert.equal(response.status, 409)
  assert.equal((await response.json()).code, 'busy')
  assert.equal(ctx.sessions.head(SID), head)
  await http.close()
})

test('parentId из чужой сессии запуск не принимает', async () => {
  const ctx = setup()
  const foreign = ctx.sessions.append({
    sessionId: OTHER,
    role: 'agent',
    text: 'чужой ответ',
    tokens: 10,
  })
  const parsed = ctx.agent.parseInput({
    sessionId: SID,
    sphere: 'финтех',
    strategy: 'branches',
    prompt: 'вопрос',
    parentId: foreign,
  })
  assert.equal(parsed.ok, false)
  assert.match(parsed.message, /Родительское сообщение не найдено/)
})

// --- Счётчик GET по стратегии (ADR, п. 3) -------------------------------

test('GET со стратегией считает счётчик по ней, без параметров — как прежде', async () => {
  const ctx = setup()
  const branches = { sphere: 'финтех', strategy: 'window', window: 1 }
  await ctx.ask({ ...branches, prompt: 'раз' })
  await ctx.ask({ ...branches, prompt: 'два' })

  const http = await serve(ctx)
  const windowed = await (
    await http.get(`/v1/sessions/${SID}?strategy=window&window=1&model=anthropic-haiku`)
  ).json()
  assert.equal(windowed.context.messages, 1, 'счётчик считает ровно окно')
  assert.equal(windowed.context.windowSize, 1)

  const plain = await (await http.get(`/v1/sessions/${SID}`)).json()
  assert.equal(plain.context.messages, undefined, 'без параметров ответ прежний')
  await http.close()
})

test('счётчик сводки зажат действующим окном модели', async () => {
  const ctx = setup()
  // Реплики заведомо шире окна: считаем по базе, запуск не нужен.
  for (let i = 1; i <= 6; i++) {
    ctx.sessions.append({
      sessionId: SID,
      role: i % 2 ? 'user' : 'agent',
      text: `реплика ${i}`,
      tokens: 500,
    })
  }
  const http = await serve(ctx)
  const url = `/v1/sessions/${SID}?strategy=summary&model=anthropic-haiku&summarizeAt=500`
  const tight = await (await http.get(`${url}&contextTokens=800`)).json()
  assert.equal(tight.context.total, 500, 'в окно 800 влезает одна реплика, а не все шесть')
  assert.equal(tight.context.willCompress, true, 'порог перейдён — при следующем сообщении сожмётся')

  const wide = await (await http.get(`${url}&contextTokens=8000`)).json()
  assert.equal(wide.context.total, 3000, 'широкое окно вмещает всё накопленное')

  // Без параметров — прежний ответ дней 7–9, без оглядки на окно.
  const plain = await (await http.get(`/v1/sessions/${SID}`)).json()
  assert.equal(plain.context.total, 3000)
  assert.equal(plain.context.willCompress, undefined)
  await http.close()
})
