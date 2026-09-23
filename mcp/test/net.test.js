// Дверь наружу. Здесь предмет проверки — не мок, а поведение настоящего
// `fetch`: локальный сервер отвечает редиректом и негабаритным телом, и
// видно, что запрет редиректа и потолок тела работают на самом деле.

import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { getJson, USER_AGENT } from '../src/net.js'

async function stub(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    base,
    async close() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

const json = (res, payload, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

test('301 не выполняется: redirect error запрещает переезд', async (t) => {
  let hitTarget = false
  const target = await stub((req, res) => {
    hitTarget = true
    json(res, { moved: true })
  })
  t.after(() => target.close())
  const moved = await stub((req, res) => {
    res.writeHead(301, { location: `${target.base}/` })
    res.end()
  })
  t.after(() => moved.close())

  await assert.rejects(getJson(`${moved.base}/`))
  // Красная ветвь этого теста — `redirect: 'follow'`: тогда запрос доходит
  // до второго хоста, `hitTarget` становится true и `rejects` не срабатывает.
  assert.equal(hitTarget, false)
})

test('тело больше потолка режется до разбора', async (t) => {
  const payload = { text: 'я'.repeat(200_000) }
  const big = await stub((req, res) => json(res, payload))
  t.after(() => big.close())

  await assert.rejects(getJson(`${big.base}/`), /больше потолка/)
  // Тот же ответ с поднятым потолком разбирается: значит режет именно
  // потолок, а не битый JSON или иная причина.
  const ok = await getJson(`${big.base}/`, { maxBytes: 4 * 1024 * 1024 })
  assert.equal(ok.text.length, 200_000)
})

test('ответ не JSON — своя ошибка, текст поставщика наружу не уходит', async (t) => {
  const html = await stub((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html>секрет поставщика</html>')
  })
  t.after(() => html.close())

  await assert.rejects(getJson(`${html.base}/`), (error) => {
    assert.ok(!String(error.message).includes('секрет поставщика'))
    return true
  })
})

test('код ответа не 2xx — отказ', async (t) => {
  const bad = await stub((req, res) => json(res, { error: 'нет' }, 503))
  t.after(() => bad.close())
  await assert.rejects(getJson(`${bad.base}/`), /503/)
})

test('User-Agent уходит и соответствует требованию Wikimedia', async (t) => {
  let seen = null
  const echo = await stub((req, res) => {
    seen = req.headers['user-agent']
    json(res, { ok: true })
  })
  t.after(() => echo.close())

  await getJson(`${echo.base}/`)
  assert.equal(seen, USER_AGENT)
  // Политика требует имя клиента с версией и контакт в скобках; без
  // контакта запросы блокируются без предупреждения.
  assert.match(seen, /^[\w.-]+\/[\d.]+ \(https:\/\/[^)]+\)/)
})

test('поставщик, который молчит, отваливается по таймауту', async (t) => {
  const silent = await stub(() => {})
  t.after(() => silent.close())

  await assert.rejects(getJson(`${silent.base}/`, { timeoutMs: 150 }))
})
