// Дверь наружу. Предмет проверки — не мок, а поведение настоящего `fetch`:
// локальный сервер отвечает редиректом, и видно, что запрет переезда
// работает на самом деле. Держатель `redirect: 'error'` в `src/net.js`
// (I-14): у `mcpnews` был случай, когда строка переехала в новую единицу, а
// тест — нет, и это стало блокирующей находкой. Здесь они переехали вместе.
//
// Второй тест держит `status` у `ProviderError`: без него исчерпанная квота
// неотличима от любого другого отказа поставщика.

import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { getJson, ProviderError } from '../src/net.js'

async function stub(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

test('301 не выполняется: redirect error запрещает переезд на другой хост', async (t) => {
  let hitTarget = false
  const target = await stub((req, res) => {
    hitTarget = true
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ moved: true }))
  })
  t.after(() => target.close())

  const moved = await stub((req, res) => {
    res.writeHead(301, { location: `${target.base}/` })
    res.end()
  })
  t.after(() => moved.close())

  await assert.rejects(getJson(`${moved.base}/`))
  // Красная ветвь: заменить `redirect: 'error'` на `'follow'` в `src/net.js` —
  // запрос доходит до второго хоста, `hitTarget` становится true, а `rejects`
  // не срабатывает (проверено прогоном: 24/24 зелёных до мутации, красный
  // этот тест после).
  assert.equal(hitTarget, false, 'запрос не должен доходить до хоста, которого нет в коде')
})

test('код отказа поставщика доезжает до вызывающего: 429 отличим от 503', async (t) => {
  const stub429 = await stub((req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ responseStatus: 429 }))
  })
  t.after(() => stub429.close())

  // Красная ветвь: убрать `{ status: response.status }` из `throw new
  // ProviderError` в `src/net.js` — `status` станет null, и оба утверждения
  // ниже покраснеют. Инструмент тогда назовёт исчерпанную квоту обычным
  // сбоем поставщика, и посетитель не узнает, что случилось на самом деле.
  await assert.rejects(getJson(`${stub429.base}/`), (error) => {
    assert.equal(error instanceof ProviderError, true)
    assert.equal(error.status, 429)
    return true
  })
})
