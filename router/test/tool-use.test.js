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
import { createRouter } from '../src/router.js'
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
      classes: ['summarize', 'tool_use', 'other'],
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

test('расход: объём messages и tools входит в оценку — исчерпанный лимит останавливает до провайдера', async (t) => {
  // Потолок 1200 токенов: выход класса summarize — 500, значит отказ может
  // прийти только от измеренного входа (~750 токенов диалога).
  const { post, calls, close } = await start(t, {
    hosts: { [CLOUD]: cloudToolUse, [LAPTOP]: laptopOk },
    apps: APPS({ dailyTokens: 1200 }),
  })
  const res = await post({
    taskClass: 'summarize',
    messages: [{ role: 'user', content: 'a'.repeat(3000) }],
    tools: [TOOL],
  })
  const body = await res.json()
  await close()
  assert.equal(res.status, 429)
  assert.equal(body.code, 'budget_exceeded')
  assert.equal(calls.length, 0, 'провайдера не звали')
})

test('выбор: определения инструментов требуют возможности tools у провайдера', async (t) => {
  const withTools = await start(t, { hosts: { [CLOUD]: cloudToolUse, [LAPTOP]: laptopOk } })
  const a = await withTools.post({
    taskClass: 'summarize',
    messages: [{ role: 'user', content: 'какие новости' }],
    tools: [TOOL],
  })
  assert.equal((await a.json()).ok, true)
  assert.deepEqual(
    withTools.calls.map((c) => c.host),
    [CLOUD],
    'ноутбук без возможности tools не зовётся',
  )
  await withTools.close()

  // Тот же класс и тот же диалог без инструментов уходит на ноутбук —
  // значит отсечка выше сделана именно наличием tools.
  const without = await start(t, { hosts: { [CLOUD]: cloudToolUse, [LAPTOP]: laptopOk } })
  const b = await without.post({
    taskClass: 'summarize',
    messages: [{ role: 'user', content: 'какие новости' }],
  })
  assert.equal((await b.json()).ok, true)
  assert.deepEqual(
    without.calls.map((c) => c.host),
    [LAPTOP],
  )
  await without.close()
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
