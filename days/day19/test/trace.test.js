// Правила записи вызова — ИСПОЛНЕНИЕМ: импортируется тот самый модуль, который
// исполняет браузер. Функция с DOM (renderCall) здесь не вызывается и не
// проверяется — её предмет визуальный, и его смотрит /design-review.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import {
  NO_METHOD,
  NO_SERVER,
  callMeta,
  callTitle,
  compareHashes,
  parseCall,
  sha256Of,
  toolName,
} from '../public/trace.js'
import { payloadOf } from '../../../agents/src/mcp/pipeline.js'
import { createRpc as createNewsRpc } from '../../../mcpnews/src/rpc.js'
import { buildTools as buildNewsTools } from '../../../mcpnews/src/tools.js'
import { createRpc as createStoreRpc } from '../../../mcpstore/src/rpc.js'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
// sha256 строки «выжимка» — посчитан `node:crypto`, не выдуман.
const SHA256_OF_SUMMARY = createHash('sha256').update('выжимка', 'utf8').digest('hex')

const event = (over = {}) => ({
  server: 'mcpstore',
  method: 'tools/call',
  request: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'file.read', arguments: {} } },
  response: { jsonrpc: '2.0', id: 1, result: { sha256: HASH_A } },
  status: 200,
  ms: 412,
  clipped: false,
  ...over,
})

test('имя сервера стоит у каждого вызова — это сквозное требование дней 18–20', () => {
  assert.ok(callTitle(parseCall(event())).startsWith('mcpstore · '))
})

test('имени сервера нет — на его месте слово, а не пустота и не выдуманное имя', () => {
  const call = parseCall(event({ server: undefined }))
  assert.equal(call.server, null)
  assert.ok(callTitle(call).startsWith(`${NO_SERVER} · `))
})

test('пустая строка именем сервера не считается', () => {
  assert.equal(parseCall(event({ server: '' })).server, null)
})

test('метода нет — тоже слово', () => {
  assert.ok(callTitle(parseCall(event({ method: undefined }))).includes(NO_METHOD))
})

test('у tools/call в заголовок попадает имя инструмента из тела запроса', () => {
  assert.equal(callTitle(parseCall(event())), 'mcpstore · tools/call file.read')
})

test('имя инструмента берётся из запроса, а не из ответа и не из порядка шагов', () => {
  const call = parseCall(event({ request: { method: 'tools/call', params: { name: 'news.search' } } }))
  assert.equal(toolName(call), 'news.search')
  assert.equal(toolName(parseCall(event({ method: 'initialize' }))), null)
  assert.equal(toolName(parseCall(event({ request: 'не json' }))), null)
})

test('тела становятся текстом один раз; отсутствующее тело — null, а не пустая строка', () => {
  const call = parseCall(event({ response: undefined }))
  assert.equal(call.response, null)
  assert.equal(typeof call.request, 'string')
  assert.equal(JSON.parse(call.request).params.name, 'file.read')
})

test('тело, пришедшее строкой, не переупаковывается', () => {
  assert.equal(parseCall(event({ response: '{"a": 1}  ' })).response, '{"a": 1}  ')
})

test('метка несёт код, длительность и размер; неизмеренного в ней нет', () => {
  assert.match(callMeta(parseCall(event())), /^HTTP 200 · 0,4 с · \d+ Б$/)
  assert.match(callMeta(parseCall(event({ status: undefined, ms: undefined }))), /^кода нет · \d+ Б$/)
})

test('нуля вместо неизмеренного не появляется', () => {
  assert.ok(!callMeta(parseCall(event({ ms: undefined }))).includes('0 мс'))
})

test('clipped от хоста отличается от обрезки страницы', () => {
  assert.equal(parseCall(event({ clipped: true })).clipped, true)
  assert.equal(parseCall(event({ clipped: 'да' })).clipped, false)
})

test('sha256 берётся из полезной части ответа и больше ниоткуда', () => {
  const inText = (payload) => JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } })
  // Ступень 1 — `structuredContent`, если сервер его дал.
  assert.equal(sha256Of(JSON.stringify({ result: { structuredContent: { sha256: HASH_B } } })), HASH_B)
  // Ступень 2 — JSON строкой в текстовом блоке: так отвечают ОБА наших
  // сервера, и ровно этой ступени странице не хватало.
  assert.equal(sha256Of(inText({ text: 'выжимка', sha256: HASH_A })), HASH_A)
  // Ступень 3 — не JSON: текст остаётся текстом, хеша в нём нет.
  assert.equal(sha256Of(JSON.stringify({ result: { content: [{ type: 'text', text: 'просто текст' }] } })), null)
  // Похожая строка в другом месте ответа хешем не считается: у неё нет имени.
  assert.equal(sha256Of(JSON.stringify({ result: { content: [{ type: 'text', text: HASH_A }] } })), null)
  assert.equal(sha256Of(inText({ sha256: 'короткий' })), null)
  // Поля `result.sha256` наши серверы не кладут, и страница его не ищет:
  // у хоста цепочки такой ступени нет тоже.
  assert.equal(sha256Of(JSON.stringify({ result: { sha256: HASH_A } })), null)
  assert.equal(sha256Of('не json'), null)
  assert.equal(sha256Of(null), null)
})

test('сверка хешей: третьего случая «наверное совпали» нет', () => {
  assert.equal(compareHashes(HASH_A, HASH_A).kind, 'ok')
  assert.equal(compareHashes(HASH_A, HASH_B).kind, 'bad')
  assert.equal(compareHashes(HASH_A, null).kind, 'unknown')
  assert.equal(compareHashes(null, null).kind, 'unknown')
  // Неизвестность не выдаётся за успех — это и есть предмет проверки.
  assert.notEqual(compareHashes(null, null).kind, 'ok')
})

// ——— отпечаток из НАСТОЯЩЕГО ответа, а не из выдуманного ———
//
// Проверки выше стоят на ответах, сочинённых этим же файлом: поле лежало там,
// где его ищут, и поэтому находилось. Экран при этом не показал ни одного
// отпечатка ни разу — держатель держал не то. Ниже ответ СТРОИТСЯ тем же
// кодом, каким его строят серверы: `createRpc` и `buildTools` импортируются
// из `mcpnews` и `mcpstore` и отвечают на настоящий `tools/call`. Разъедется
// форма ответа сервера — покраснеет здесь, а не на проде.

const rpcCall = async (rpc, name, args) =>
  JSON.stringify(await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }))

test('отпечаток достаётся из настоящего ответа news.summarize', async () => {
  const rpc = createNewsRpc({ serverInfo: { name: 'mcpnews', version: 'test' }, tools: buildNewsTools() })
  const response = await rpcCall(rpc, 'news.summarize', {
    items: [{ title: 'Jev привлёк 10 млн', url: 'https://example.com/a', points: 5 }],
  })
  // Отпечаток берётся из самого ответа, а не из константы теста: предмет
  // проверки — что страница НАХОДИТ его в этой форме, а не какой он.
  const expected = JSON.parse(JSON.parse(response).result.content[0].text).sha256
  assert.match(expected, /^[0-9a-f]{64}$/, 'сервер не дал отпечатка — проверять нечего')
  assert.equal(sha256Of(response), expected)
})

test('отпечаток достаётся из настоящего ответа file.read', async () => {
  // Берётся настоящий `createRpc` единицы `mcpstore` — тот самый код, который
  // упаковывает итог инструмента в ответ (`mcpstore/src/rpc.js:94`). Сам
  // инструмент здесь подставной: настоящий тянет `node:sqlite` через
  // `store.js`, а хранилище к предмету проверки отношения не имеет —
  // проверяется ФОРМА ОТВЕТА, и она вся в этом файле.
  const tool = {
    name: 'file.read',
    title: 'подставной file.read',
    description: 'подставной',
    inputSchema: { type: 'object' },
    parse: (args) => ({ ok: true, value: args }),
    run: () => ({ found: true, content: 'выжимка', sha256: SHA256_OF_SUMMARY }),
  }
  const rpc = createStoreRpc({ serverInfo: { name: 'mcpstore', version: 'test' }, tools: [tool] })
  const response = await rpcCall(rpc, 'file.read', { name: 'pipeline-test.txt' })
  assert.equal(sha256Of(response), SHA256_OF_SUMMARY)
})

// Один контракт — одно чтение. Хост цепочки (`payloadOf`) и страница
// (`sha256Of`) разбирают ОДИН И ТОТ ЖЕ ответ, и разъехались они молча: хост
// умел три ступени, страница — две. Таблица ниже проходит обе стороны по
// одним и тем же формам ответа; расхождение на любой строке — красное.
test('страница и хост цепочки читают ответ одинаково', () => {
  const HASH_C = 'c'.repeat(64)
  const results = [
    { structuredContent: { sha256: HASH_C } },
    { content: [{ type: 'text', text: JSON.stringify({ text: 'выжимка', sha256: HASH_C }) }] },
    { content: [{ type: 'text', text: 'просто текст' }] },
    { content: [{ type: 'text', text: HASH_C }] },
    { content: [] },
    { content: [{ type: 'text', text: JSON.stringify({ sha256: 'короткий' }) }] },
  ]
  for (const result of results) {
    const text = (result.content ?? [])
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
    const fromHost = payloadOf({ structured: result.structuredContent ?? null, text }).sha256
    const expected = typeof fromHost === 'string' && /^[0-9a-f]{64}$/.test(fromHost) ? fromHost : null
    assert.equal(sha256Of(JSON.stringify({ jsonrpc: '2.0', id: 1, result })), expected, JSON.stringify(result))
  }
})
