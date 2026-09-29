// Нативный `tool_use` в роутере (ADR 2026-09-28-0736, п. 2): вход диалогом с
// блоками, определения инструментов провайдеру, ответ блоками. Сюда же —
// обратная совместимость строкового `input` дней 6–16 и держатели правил
// расхода и выбора по I-14.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import { test } from 'node:test'
import { loadConfig } from '../src/config.js'
import { createLedger } from '../src/ledger.js'
import { createStaticRegistry } from '../src/registry.js'
import { createRouter, inputTextOf } from '../src/router.js'
import { createService } from '../src/service.js'
import { ENV, httpJson, ollamaGenerate, PROVIDERS, scriptedFetch } from './fixtures.js'

const CLASSES = JSON.parse(readFileSync(new URL('../config/classes.json', import.meta.url), 'utf8'))
const LAPTOP = 'laptop.test:11434'
const CLOUD = 'api.anthropic.test'

/** Ответ Anthropic с блоком `tool_use` — форма из документации провайдера. */
function anthropicToolUse({ id = 'toolu_01A', name = 'mcpnews__news_search', input = { query: 'fintech' } } = {}) {
  return {
    id: 'msg_01XFDUDYJgAACzvnptvVoYEL',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5',
    content: [
      { type: 'text', text: 'Посмотрю новости.' },
      { type: 'tool_use', id, name, input },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 40 },
  }
}

const TOOL = {
  name: 'mcpnews__news_search',
  description: 'Поиск свежих новостей',
  input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
}

const APPS = (limits = { dailyTokens: 50000, dailyCostUsd: 1 }) => ({
  admin: { secretEnv: 'ROUTER_ADMIN_KEY' },
  apps: [
    {
      id: 'smoke',
      secretEnv: 'APP_KEY_SMOKE',
      classes: ['summarize', 'layered_dialogue', 'tool_use', 'other'],
      limits,
    },
  ],
})

/**
 * Служба на случайном порту. Закрытие регистрируется на контексте теста:
 * упавшее утверждение иначе оставило бы сервер открытым и подвесило прогон.
 */
async function start(t, { hosts, apps = APPS(), file } = {}) {
  const calls = []
  const now = () => Date.parse('2026-09-28T10:00:00Z')
  const config = loadConfig({ providers: PROVIDERS, classes: CLASSES, apps, env: ENV })
  const router = createRouter({
    config,
    registry: createStaticRegistry(config.providers),
    fetchImpl: scriptedFetch(hosts, { calls }),
    now,
    env: ENV,
  })
  const ledger = createLedger({ file, now })
  const server = http.createServer(createService({ config, router, ledger, env: ENV, now }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (body) =>
    fetch(`${base}/v1/route`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ENV.APP_KEY_SMOKE}` },
      body: JSON.stringify(body),
    })
  const close = () => new Promise((r) => server.close(() => r()))
  t.after(close)
  return { post, calls, close }
}

const cloudToolUse = () => httpJson(200, anthropicToolUse())
const laptopOk = () => httpJson(200, ollamaGenerate({ text: 'ответ ноутбука' }))

test('обратная совместимость: строковый input уходит одним сообщением user, tools в теле нет', async (t) => {
  const { post, calls, close } = await start(t, { hosts: { [LAPTOP]: laptopOk } })
  const res = await post({ taskClass: 'summarize', input: 'текст дня 7' })
  const body = await res.json()
  await close()
  assert.equal(res.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.text, 'ответ ноутбука')
  // Ноутбук — первый ярус класса summarize: без tools выбор прежний.
  assert.equal(calls[0].host, LAPTOP)
  assert.equal(calls[0].body.prompt, 'текст дня 7')
  assert.equal(calls.length, 1)
})

test('messages с блоками уходят провайдеру как есть: tool_use и tool_result не склеиваются', async (t) => {
  const { post, calls, close } = await start(t, { hosts: { [CLOUD]: () => httpJson(200, anthropicToolUse({ id: 'toolu_02B' })) } })
  const messages = [
    { role: 'user', content: 'какие новости' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Посмотрю.' },
        { type: 'tool_use', id: 'toolu_01A', name: 'mcpnews__news_search', input: { query: 'fintech' } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_01A', content: '3 заголовка' }],
    },
  ]
  const res = await post({ taskClass: 'tool_use', messages, tools: [TOOL] })
  const body = await res.json()
  await close()
  assert.equal(res.status, 200)
  assert.equal(calls[0].host, CLOUD)
  assert.deepEqual(calls[0].body.messages, messages)
  assert.equal(body.ok, true)
})

test('определения инструментов уходят в запрос как name/description/input_schema', async (t) => {
  const { post, calls, close } = await start(t, { hosts: { [CLOUD]: cloudToolUse } })
  await post({
    taskClass: 'tool_use',
    messages: [{ role: 'user', content: 'какие новости' }],
    tools: [TOOL],
  })
  await close()
  assert.deepEqual(calls[0].body.tools, [
    { name: TOOL.name, description: TOOL.description, input_schema: TOOL.input_schema },
  ])
})

test('ответ с tool_use виден вызывающему блоками и stopReason tool_use, а не строкой', async (t) => {
  const { post, close } = await start(t, { hosts: { [CLOUD]: cloudToolUse } })
  const res = await post({
    taskClass: 'tool_use',
    messages: [{ role: 'user', content: 'какие новости' }],
    tools: [TOOL],
  })
  const body = await res.json()
  await close()
  assert.equal(body.ok, true)
  assert.equal(body.stopReason, 'tool_use')
  const block = body.content.find((b) => b.type === 'tool_use')
  assert.deepEqual(block, {
    type: 'tool_use',
    id: 'toolu_01A',
    name: 'mcpnews__news_search',
    input: { query: 'fintech' },
  })
  // Текст остаётся текстом: вызов инструмента в него не попадает.
  assert.equal(body.text, 'Посмотрю новости.')
})

test('ответ из одних блоков tool_use не считается пустым', async (t) => {
  const onlyToolUse = () => {
    const json = anthropicToolUse()
    json.content = json.content.filter((b) => b.type === 'tool_use')
    return httpJson(200, json)
  }
  const { post, calls, close } = await start(t, { hosts: { [CLOUD]: onlyToolUse } })
  const res = await post({
    taskClass: 'tool_use',
    messages: [{ role: 'user', content: 'какие новости' }],
    tools: [TOOL],
  })
  const body = await res.json()
  await close()
  assert.equal(body.ok, true)
  assert.equal(body.text, '')
  assert.equal(body.content.length, 1)
  // Фолбэка по «пустому 200» не было: провайдера звали один раз.
  assert.equal(calls.length, 1)
})

// Определение инструмента на 8 000 знаков: сам диалог и строка входа малы,
// поэтому выйти за потолок 2000 токенов может только мера определений.
// Класс tool_use: выход 1024 токена, единственный способный провайдер —
// значит оценка равна (вход + 1024).
const FAT_TOOL = { ...TOOL, description: 'x'.repeat(8000) }

test('расход: определения инструментов входят в меру при входе messages', async (t) => {
  const messages = [{ role: 'user', content: 'какие новости' }]
  const withTools = await start(t, {
    hosts: { [CLOUD]: cloudToolUse },
    apps: APPS({ dailyTokens: 2000, dailyCostUsd: 1 }),
  })
  const res = await withTools.post({ taskClass: 'tool_use', messages, tools: [FAT_TOOL] })
  const body = await res.json()
  await withTools.close()
  assert.equal(res.status, 429)
  assert.equal(body.code, 'budget_exceeded')
  assert.equal(withTools.calls.length, 0, 'провайдера не звали')

  // Тот же класс, тот же диалог и тот же потолок без определений проходит —
  // значит отказ выше дала мера tools, а не размер диалога или лимит.
  const without = await start(t, {
    hosts: { [CLOUD]: cloudToolUse },
    apps: APPS({ dailyTokens: 2000, dailyCostUsd: 1 }),
  })
  const ok = await without.post({ taskClass: 'tool_use', messages })
  assert.equal(ok.status, 200)
  assert.equal(without.calls.length, 1)
  await without.close()
})

test('расход: определения инструментов входят в меру и при строковом входе input', async (t) => {
  const withTools = await start(t, {
    hosts: { [CLOUD]: cloudToolUse },
    apps: APPS({ dailyTokens: 2000, dailyCostUsd: 1 }),
  })
  const res = await withTools.post({
    taskClass: 'tool_use',
    input: 'какие новости',
    tools: [FAT_TOOL],
  })
  const body = await res.json()
  await withTools.close()
  assert.equal(res.status, 429)
  assert.equal(body.code, 'budget_exceeded')
  assert.equal(withTools.calls.length, 0, 'провайдера не звали')

  // Та же строка и тот же потолок без определений проходит.
  const without = await start(t, {
    hosts: { [CLOUD]: cloudToolUse },
    apps: APPS({ dailyTokens: 2000, dailyCostUsd: 1 }),
  })
  const ok = await without.post({ taskClass: 'tool_use', input: 'какие новости' })
  assert.equal(ok.status, 200)
  assert.equal(without.calls.length, 1)
  await without.close()
})

test('мера входа не меняет ключ кэша строкового входа без tools', () => {
  // Держатель оговорки в inputTextOf: припиши мера пустой `[]` — ключ дней
  // 6–16 сдвинулся бы, и весь кэш промахнулся бы разом.
  assert.equal(inputTextOf({ input: 'текст дня 7' }), 'текст дня 7')
  assert.equal(inputTextOf({ input: 'текст дня 7', tools: [] }), 'текст дня 7')
})

test('tools[] принимает только класс, объявивший tools: на summarize отказ до вызова', async (t) => {
  const messages = [{ role: 'user', content: 'какие новости' }]
  const refused = await start(t, { hosts: { [CLOUD]: cloudToolUse, [LAPTOP]: laptopOk } })
  const a = await refused.post({ taskClass: 'summarize', messages, tools: [TOOL] })
  const body = await a.json()
  assert.equal(body.ok, false)
  assert.equal(body.code, 'refused')
  assert.match(body.reason ?? body.message ?? '', /не принимает tools/)
  assert.equal(refused.calls.length, 0, 'провайдера не звали')
  await refused.close()

  // Тот же класс и тот же диалог без определений уходит провайдеру — значит
  // отсечку дало именно наличие tools, а не класс и не диалог.
  const without = await start(t, { hosts: { [CLOUD]: cloudToolUse, [LAPTOP]: laptopOk } })
  const b = await without.post({ taskClass: 'summarize', messages })
  assert.equal((await b.json()).ok, true)
  assert.deepEqual(
    without.calls.map((c) => c.host),
    [LAPTOP],
  )
  await without.close()

  // А класс, объявивший tools, их принимает — и уходит к провайдеру с
  // возможностью tools, а не на ноутбук.
  const allowed = await start(t, { hosts: { [CLOUD]: cloudToolUse, [LAPTOP]: laptopOk } })
  const c = await allowed.post({ taskClass: 'tool_use', messages, tools: [TOOL] })
  assert.equal((await c.json()).ok, true)
  assert.deepEqual(
    allowed.calls.map((x) => x.host),
    [CLOUD],
  )
  await allowed.close()
})

test('проба compliance: layered_dialogue с tools и answerTokens 32000 не доходит до провайдера', async (t) => {
  // Класс разрешает 32 000 токенов ответа и стоит в списке приложения, но
  // tools не объявляет. Потолок ответа берёт класс запроса — а класс с таким
  // потолком инструментов не принимает.
  assert.equal(CLASSES.layered_dialogue.maxAnswerTokens, 32000)
  assert.equal(CLASSES.layered_dialogue.requires.includes('tools'), false)
  // Лимиты — как у развёрнутого приложения agents: отказ должен прийти от
  // класса, а не от того, что запрос не помещается в тестовый потолок.
  const { post, calls, close } = await start(t, {
    hosts: { [CLOUD]: cloudToolUse, [LAPTOP]: laptopOk },
    apps: APPS({ dailyTokens: 10000000, dailyCostUsd: 10 }),
  })
  const res = await post({
    taskClass: 'layered_dialogue',
    messages: [{ role: 'user', content: 'какие новости' }],
    tools: [TOOL],
    answerTokens: 32000,
  })
  const body = await res.json()
  await close()
  assert.equal(body.ok, false)
  assert.equal(body.code, 'refused')
  assert.equal(calls.length, 0, 'max_tokens 32000 провайдеру не уходил')
})

test('класс tool_use: требует tools, потолок ответа 2048 — выше отказ до вызова', async (t) => {
  assert.deepEqual(CLASSES.tool_use.requires, ['text_generation', 'tools'])
  assert.equal(CLASSES.tool_use.answerTokens, 1024)
  assert.equal(CLASSES.tool_use.maxAnswerTokens, 2048)
  const { post, calls, close } = await start(t, { hosts: { [CLOUD]: cloudToolUse } })
  const res = await post({
    taskClass: 'tool_use',
    messages: [{ role: 'user', content: 'какие новости' }],
    tools: [TOOL],
    answerTokens: 4096,
  })
  const body = await res.json()
  await close()
  assert.equal(body.ok, false)
  assert.equal(body.code, 'refused')
  assert.equal(calls.length, 0)
})

test('вход ровно один: input вместе с messages — 400, провайдера не звали', async (t) => {
  const { post, calls, close } = await start(t, { hosts: { [CLOUD]: cloudToolUse } })
  const res = await post({
    taskClass: 'tool_use',
    input: 'строка',
    messages: [{ role: 'user', content: 'какие новости' }],
  })
  const body = await res.json()
  await close()
  assert.equal(res.status, 400)
  assert.match(body.message, /ровно один вход/)
  assert.equal(calls.length, 0)
})

test('кривые блоки и определения инструментов отвергаются до вызова', async (t) => {
  const { post, calls, close } = await start(t, { hosts: { [CLOUD]: cloudToolUse } })
  const cases = [
    [{ taskClass: 'tool_use', messages: [{ role: 'system', content: 'x' }] }, /role/],
    [
      { taskClass: 'tool_use', messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }] },
      /неизвестный тип блока/,
    ],
    [
      {
        taskClass: 'tool_use',
        messages: [{ role: 'assistant', content: [{ type: 'tool_use', name: 'n', input: {} }] }],
      },
      /tool_use: id/,
    ],
    [
      {
        taskClass: 'tool_use',
        messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'x' }] }],
      },
      /tool_use_id/,
    ],
    [
      {
        taskClass: 'tool_use',
        messages: [{ role: 'user', content: 'вопрос' }],
        tools: [{ ...TOOL, name: 'clock.now' }],
      },
      /name/,
    ],
  ]
  for (const [body, re] of cases) {
    const res = await post(body)
    assert.equal(res.status, 400, JSON.stringify(body))
    assert.match((await res.json()).message, re)
  }
  await close()
  assert.equal(calls.length, 0)
})

// ——— Блоки размышления на ВХОДЕ (ADR 2026-09-29-0236; находка ревью).
//
// Круг 2 хода дня 20 присылает роутеру диалог, где ответ модели начинается
// блоком `thinking`: у провайдера блок обязан вернуться вместе с подписью,
// иначе он отвергает ход. Пока входной проверяющий этих типов не знал, такой
// круг падал с `bad_request`, и ЛЮБОЙ ход, где модель действительно думала,
// не доходил до ответа.
//
// Проверка идёт через НАСТОЯЩИЙ `createService` с настоящими `loadConfig` и
// `classes.json`. Подставной роутер агента это место не проходит вовсе — и
// именно поэтому тесты агента были зелены при неработающей цепочке.

/** Круг 2: ответ модели с размышлением вернулся в диалог, результат готов. */
const secondRound = (assistant) => ({
  taskClass: 'tool_use',
  provider: 'anthropic-haiku',
  thinking: 'low',
  answerTokens: 1024,
  tools: [TOOL],
  messages: [
    { role: 'user', content: 'какие новости' },
    { role: 'assistant', content: assistant },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_01A', content: '{"items":[]}' }],
    },
  ],
})

test('круг 2 с блоком размышления доходит до провайдера, а не падает на входе', async (t) => {
  const { post, calls, close } = await start(t, { hosts: { [CLOUD]: cloudToolUse } })
  const res = await post(
    secondRound([
      { type: 'thinking', thinking: 'Сначала посмотрю новости.', signature: 'sig-abc' },
      { type: 'tool_use', id: 'toolu_01A', name: TOOL.name, input: { query: 'fintech' } },
    ]),
  )
  const body = await res.json()
  await close()
  assert.equal(res.status, 200, `круг 2 отвергнут входом: ${JSON.stringify(body)}`)
  // Улика — вызов к провайдеру, а не код ответа: до правки их было ноль.
  assert.equal(calls.length, 1, 'запрос до провайдера не дошёл')
  const sent = calls[0].body.messages.find((m) => m.role === 'assistant').content
  // Блок уходит провайдеру НЕТРОНУТЫМ, вместе с подписью: без неё он
  // отвергает ход целиком, и роутеру переписывать её нечем.
  assert.deepEqual(sent[0], { type: 'thinking', thinking: 'Сначала посмотрю новости.', signature: 'sig-abc' })
})

test('скрытый блок размышления проходит вход и уходит провайдеру нетронутым', async (t) => {
  const { post, calls, close } = await start(t, { hosts: { [CLOUD]: cloudToolUse } })
  const res = await post(
    secondRound([
      { type: 'redacted_thinking', data: 'EroBCkYIBBgCKkBcQ' },
      { type: 'tool_use', id: 'toolu_01A', name: TOOL.name, input: { query: 'fintech' } },
    ]),
  )
  await close()
  assert.equal(res.status, 200)
  const sent = calls[0].body.messages.find((m) => m.role === 'assistant').content
  assert.deepEqual(sent[0], { type: 'redacted_thinking', data: 'EroBCkYIBBgCKkBcQ' })
})

// Расширение входа — не дыра: форма новых типов проверяется наравне с
// прежними. Подпись здесь не формальность: без неё провайдер отвергает ход
// целиком, и поймать это на входе честнее, чем ответом «invalid request».
test('блок размышления без подписи отвергается входом, а не уезжает к провайдеру', async (t) => {
  const { post, calls, close } = await start(t, { hosts: { [CLOUD]: cloudToolUse } })
  const res = await post(
    secondRound([
      { type: 'thinking', thinking: 'думаю' },
      { type: 'tool_use', id: 'toolu_01A', name: TOOL.name, input: { query: 'fintech' } },
    ]),
  )
  const body = await res.json()
  await close()
  assert.equal(res.status, 400)
  assert.match(body.message, /signature/)
  assert.equal(calls.length, 0, 'блок без подписи всё-таки уехал к провайдеру')
})

test('скрытый блок без данных отвергается входом', async (t) => {
  const { post, calls, close } = await start(t, { hosts: { [CLOUD]: cloudToolUse } })
  const res = await post(
    secondRound([
      { type: 'redacted_thinking' },
      { type: 'tool_use', id: 'toolu_01A', name: TOOL.name, input: { query: 'fintech' } },
    ]),
  )
  await close()
  assert.equal(res.status, 400)
  assert.equal(calls.length, 0)
})

// Вход расширен ровно на два типа и ни на один больше: «пропускаем что угодно»
// прошло бы все проверки выше и не прошло бы эту.
test('неизвестный тип блока по-прежнему отвергается входом', async (t) => {
  const { post, calls, close } = await start(t, { hosts: { [CLOUD]: cloudToolUse } })
  const res = await post(
    secondRound([
      { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} },
      { type: 'tool_use', id: 'toolu_01A', name: TOOL.name, input: { query: 'fintech' } },
    ]),
  )
  const body = await res.json()
  await close()
  assert.equal(res.status, 400)
  assert.match(body.message, /неизвестный тип блока server_tool_use/)
  assert.equal(calls.length, 0)
})
