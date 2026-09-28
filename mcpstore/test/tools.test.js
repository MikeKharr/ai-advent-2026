// Инструменты хранилища: имя — не путь, потолки держат, срок стирает,
// прочитанное совпадает с сохранённым побайтно и по sha256.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { call, startService, T0, toolPayload } from './helpers.js'

const save = (base, name, content) => call(base, 'file.save', { name, content })

test('сохранённое читается тем же текстом и тем же sha256', async (t) => {
  const service = await startService()
  t.after(() => service.close())

  const text = 'Сводка новостей\nстрока вторая'
  const saved = toolPayload((await save(service.base, 'digest.txt', text)).json())
  const read = toolPayload((await call(service.base, 'file.read', { name: 'digest.txt' })).json())

  assert.equal(read.found, true)
  assert.equal(read.content, text)
  // Ровно эту сверку делает цепочка дня 19 после `file.read`.
  assert.equal(read.sha256, saved.sha256)
  assert.equal(saved.sha256, createHash('sha256').update(text, 'utf8').digest('hex'))
})

test('имя с путём отвергается: до хранилища запрос не доходит', async (t) => {
  const service = await startService()
  t.after(() => service.close())

  for (const bad of ['../../etc/passwd', 'a/b.txt', '/abs.txt', 'c:\\x', '.hidden', 'a..b']) {
    const body = (await save(service.base, bad, 'x')).json()
    // Красная ветвь: снять проверку `validName` в `save()` (`src/store.js`) —
    // имя проходит, и `file.list` перестаёт быть пустым.
    assert.equal(body.result.isError, true, `имя ${bad} обязано быть отвергнуто`)
  }
  assert.deepEqual(toolPayload((await call(service.base, 'file.list', {})).json()).files, [])
})

test('отказ инструмента приходит через isError, а не через error протокола', async (t) => {
  const service = await startService()
  t.after(() => service.close())

  const body = (await save(service.base, 'ok.txt', 12345)).json()
  assert.equal(body.error, undefined, 'негодный аргумент не рвёт протокол')
  assert.equal(body.result.isError, true)
  assert.match(JSON.parse(body.result.content[0].text).error, /content/)
})

test('файл больше 64 КБ не сохраняется', async (t) => {
  const service = await startService()
  t.after(() => service.close())

  const body = (await save(service.base, 'big.txt', 'я'.repeat(40_000))).json() // 80 000 байт в utf-8
  assert.equal(body.result.isError, true)
  assert.deepEqual(toolPayload((await call(service.base, 'file.list', {})).json()).files, [])
})

test('ровно 64 КБ сохраняется, 64 КБ + 1 байт — нет', async (t) => {
  const service = await startService()
  t.after(() => service.close())

  const edge = 'a'.repeat(64 * 1024)
  assert.equal((await save(service.base, 'edge.txt', edge)).json().result.isError, undefined)
  // Красная ветвь: заменить `>` на `>=` в проверке потолка (`src/tools.js`) —
  // краснеет первое утверждение; убрать проверку вовсе — второе.
  assert.equal((await save(service.base, 'over.txt', `${edge}a`)).json().result.isError, true)
})

test('двести первый файл отвергается, перезапись существующего — нет', async (t) => {
  const service = await startService()
  t.after(() => service.close())

  for (let i = 0; i < 200; i += 1) {
    const body = (await save(service.base, `f${String(i).padStart(3, '0')}.txt`, 'x')).json()
    assert.equal(body.result.isError, undefined, `файл ${i} обязан сохраниться`)
  }
  const overflow = (await save(service.base, 'f200.txt', 'x')).json()
  assert.equal(overflow.result.isError, true)
  assert.match(JSON.parse(overflow.result.content[0].text).error, /заполнено/)

  // Перезапись числа файлов не меняет и потолком отвергаться не должна.
  const rewrite = toolPayload((await save(service.base, 'f000.txt', 'y')).json())
  assert.equal(rewrite.replaced, true)
  assert.equal(toolPayload((await call(service.base, 'file.list', {})).json()).count, 200)
})

test('файл старше 30 часов не читается и не занимает место в потолке', async (t) => {
  const service = await startService()
  t.after(() => service.close())

  await save(service.base, 'old.txt', 'старое')
  // Ровно 30 часов — ещё живой: срок считается строгим сравнением.
  service.time.ms = T0 + 30 * 60 * 60 * 1000
  assert.equal(toolPayload((await call(service.base, 'file.read', { name: 'old.txt' })).json()).found, true)

  service.time.ms = T0 + 30 * 60 * 60 * 1000 + 1
  const read = toolPayload((await call(service.base, 'file.read', { name: 'old.txt' })).json())
  // Красная ветвь: увеличить TTL_MS в `src/store.js` — found снова true.
  assert.equal(read.found, false)
  assert.equal(toolPayload((await call(service.base, 'file.list', {})).json()).count, 0)
})

test('отсутствующий файл — found: false, а не отказ', async (t) => {
  const service = await startService()
  t.after(() => service.close())

  const body = (await call(service.base, 'file.read', { name: 'нет.txt' })).json()
  // Имя с кириллицей вне белого списка — это отказ; берём законное имя.
  assert.equal(body.result.isError, true)

  const ok = (await call(service.base, 'file.read', { name: 'missing.txt' })).json()
  assert.equal(ok.result.isError, undefined)
  assert.deepEqual(toolPayload(ok), { found: false, name: 'missing.txt' })
})

test('file.list отдаёт имена по возрастанию и не отдаёт содержимого', async (t) => {
  const service = await startService()
  t.after(() => service.close())

  await save(service.base, 'b.txt', 'тело b')
  await save(service.base, 'a.txt', 'тело a')

  const payload = toolPayload((await call(service.base, 'file.list', {})).json())
  assert.deepEqual(
    payload.files.map((f) => f.name),
    ['a.txt', 'b.txt'],
  )
  assert.equal(JSON.stringify(payload).includes('тело'), false, 'содержимое в списке не показывается')
  assert.deepEqual(Object.keys(payload.files[0]).sort(), ['bytes', 'expiresAt', 'name', 'savedAt', 'sha256'])
})

test('состояние переживает перезапуск процесса: файл лежит в базе на томе', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpstore-'))
  const dbPath = path.join(dir, 'store.db')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const first = await startService({ path: dbPath })
  await save(first.base, 'kept.txt', 'переживёт')
  await first.close()

  // Второй стенд — новый процесс хранилища поверх того же файла.
  const second = await startService({ path: dbPath })
  t.after(() => second.close())
  const read = toolPayload((await call(second.base, 'file.read', { name: 'kept.txt' })).json())
  assert.equal(read.content, 'переживёт')
})
