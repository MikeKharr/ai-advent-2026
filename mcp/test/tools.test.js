// Инструменты: аргумент никогда не адрес, хосты зашиты, ответ поставщика —
// недоверенные данные. Сеть здесь подменена, но только она: схема, разбор и
// сборка ответа — настоящие.

import assert from 'node:assert/strict'
import test from 'node:test'
import { rpc, startService, toolPayload } from './helpers.js'

function recorder(replies) {
  const urls = []
  const fetchImpl = async (url) => {
    urls.push(String(url))
    const body = replies.shift()
    if (body === undefined) throw new Error('лишний запрос наружу')
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { urls, fetchImpl }
}

const call = (base, name, args) =>
  rpc(base, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })

test('аргумент-URL отвергается схемой: инструмент не запускается', async (t) => {
  const { urls, fetchImpl } = recorder([])
  const service = await startService({ fetchImpl })
  t.after(() => service.close())

  const res = await call(service.base, 'weather.current', { city: 'http://169.254.169.254/latest' })
  const body = res.json()
  // Красная ветвь: снять `.refine(...)` в `plainArg` — тогда аргумент
  // проходит, инструмент исполняется, и `urls` перестаёт быть пустым.
  assert.ok(body.error || body.result?.isError, 'адрес в аргументе обязан быть отвергнут')
  assert.deepEqual(urls, [])
})

test('аргумент со слэшем отвергается: путь — тоже адрес', async (t) => {
  const { urls, fetchImpl } = recorder([])
  const service = await startService({ fetchImpl })
  t.after(() => service.close())

  const res = await call(service.base, 'wiki.summary', { title: '../../etc/passwd' })
  const body = res.json()
  assert.ok(body.error || body.result?.isError)
  assert.deepEqual(urls, [])
})

test('обычное название города проходит и ходит только на зашитые хосты', async (t) => {
  const { urls, fetchImpl } = recorder([
    { results: [{ name: 'Сингапур', country: 'Сингапур', latitude: 1.28967, longitude: 103.85007 }] },
    { current: { time: '2026-09-23T12:00', temperature_2m: 29.4, wind_speed_10m: 11.2 } },
  ])
  const service = await startService({ fetchImpl })
  t.after(() => service.close())

  const payload = toolPayload((await call(service.base, 'weather.current', { city: 'Сингапур' })).json())
  assert.equal(payload.found, true)
  assert.equal(payload.temperatureC, 29.4)
  assert.equal(payload.windKmh, 11.2)
  assert.equal(payload.place.name, 'Сингапур')

  assert.equal(urls.length, 2)
  assert.ok(urls[0].startsWith('https://geocoding-api.open-meteo.com/v1/search?'))
  assert.ok(urls[1].startsWith('https://api.open-meteo.com/v1/forecast?'))
})

test('координаты из ответа поставщика не дописывают параметр в адрес', async (t) => {
  const { urls, fetchImpl } = recorder([
    // Поставщик (или тот, кто им притворился) возвращает строку вместо числа.
    { results: [{ name: 'X', country: 'Y', latitude: '1&current=secret', longitude: 2 }] },
  ])
  const service = await startService({ fetchImpl })
  t.after(() => service.close())

  const body = (await call(service.base, 'weather.current', { city: 'X' })).json()
  assert.equal(body.result.isError, true)
  // Второго запроса не было: адрес прогноза не собрался.
  assert.equal(urls.length, 1)
})

test('город не найден — честный ответ без второго запроса', async (t) => {
  const { urls, fetchImpl } = recorder([{ generationtime_ms: 0.1 }])
  const service = await startService({ fetchImpl })
  t.after(() => service.close())

  const payload = toolPayload((await call(service.base, 'weather.current', { city: 'Ннн' })).json())
  assert.equal(payload.found, false)
  assert.equal(urls.length, 1)
})

test('ссылку на статью собираем сами: адрес из ответа поставщика не переносится', async (t) => {
  const { fetchImpl } = recorder([
    {
      title: 'Сингапур',
      extract: 'Город-государство в Юго-Восточной Азии.',
      titles: { canonical: 'Сингапур' },
      content_urls: { desktop: { page: 'https://evil.example/подделка' } },
    },
  ])
  const service = await startService({ fetchImpl })
  t.after(() => service.close())

  const payload = toolPayload((await call(service.base, 'wiki.summary', { title: 'Сингапур' })).json())
  assert.equal(payload.title, 'Сингапур')
  assert.ok(payload.url.startsWith('https://ru.wikipedia.org/wiki/'))
  assert.ok(!JSON.stringify(payload).includes('evil.example'))
})

test('длинная выдержка обрезается: сырой текст поставщика наружу не льётся', async (t) => {
  const { fetchImpl } = recorder([
    { title: 'Т', extract: 'я'.repeat(9000), titles: { canonical: 'Т' } },
  ])
  const service = await startService({ fetchImpl })
  t.after(() => service.close())

  const payload = toolPayload((await call(service.base, 'wiki.summary', { title: 'Т' })).json())
  assert.equal(payload.extract.length, 1500)
})
