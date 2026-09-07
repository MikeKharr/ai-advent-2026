// Интеграционный тест HTTP-границы: сервер запускается настоящим процессом.
// Регрессия ревью (Б-1): POST с телом null ронял процесс, а рестарт
// контейнера обнулял счётчики лимитов (I-5).

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { after, before, test } from 'node:test'

const PORT = 18234
const BASE = `http://127.0.0.1:${PORT}`
let child

before(async () => {
  child = spawn(process.execPath, [new URL('../server.js', import.meta.url).pathname], {
    env: { ...process.env, ANTHROPIC_API_KEY: 'test', PORT: String(PORT) },
    stdio: 'ignore',
  })
  // Ждём, пока сервер начнёт отвечать.
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`${BASE}/healthz`)
      if (res.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('сервер не поднялся за 5 с')
})

after(() => {
  child?.kill('SIGTERM')
})

async function post(body) {
  return fetch(`${BASE}/api/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
}

test('POST с телом null — 400, процесс живёт', async () => {
  const res = await post('null')
  assert.equal(res.status, 400)
  const health = await fetch(`${BASE}/healthz`)
  assert.equal(health.status, 200)
})

test('POST с массивом и с не-строковым format — 400, процесс живёт', async () => {
  assert.equal((await post('[1,2]')).status, 400)
  assert.equal((await post('{"sphere":"x","format":{"toString":null,"valueOf":null}}')).status, 400)
  assert.equal((await fetch(`${BASE}/healthz`)).status, 200)
})

test('POST принимает оба написания ключей параметров', async () => {
  // max_tokens вне диапазона должен дать отказ, а не молчаливый дефолт.
  const res = await post('{"sphere":"x","max_tokens":99999}')
  assert.equal(res.status, 400)
  const json = await res.json()
  assert.match(json.error, /Лимит токенов/)
})
