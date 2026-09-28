// Дверь наружу. Предмет проверки — не мок, а поведение настоящего `fetch`:
// локальный сервер отвечает редиректом, и видно, что запрет переезда
// работает на самом деле. Держатель `redirect: 'error'` в `src/net.js`
// (I-14): в единице дня 16 то же правило держит `mcp/test/net.test.js`,
// сюда строка переехала без теста — исправлено.

import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { getJson } from '../src/net.js'

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
