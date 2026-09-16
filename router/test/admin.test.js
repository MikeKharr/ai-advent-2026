// Скрипт чтения расхода запускается в окружении контейнера, где лежат ключи
// провайдеров и администратора (ADR 2026-09-16-0907). Поэтому проверяется
// настоящим процессом и по всем веткам, а не только по успешной: значения
// ключа нет ни в одном выводе — ни при 200, ни при ошибке сервера, ни при
// обрыве сети, ни при плохом аргументе.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import { test } from 'node:test'

const apps = JSON.parse(readFileSync(new URL('../config/apps.json', import.meta.url), 'utf8'))

// Значение различимое: если оно утечёт в вывод, найдётся поиском по строке.
const SECRET = 'test-admin-secret-value'
const BODY_200 = '{"day":{"agents":{"costUsd":0.42}}}'

/**
 * Поддельный роутер на свободном порту. `mode` — что отвечать;
 * 500 возвращает полученный заголовок authorization эхом в теле.
 */
async function withServer(mode, run) {
  const seen = { requests: 0, authorization: null }
  const server = http.createServer((req, res) => {
    seen.requests += 1
    seen.authorization = req.headers.authorization
    if (mode === 200) return res.writeHead(200).end(BODY_200)
    if (mode === 401) return res.writeHead(401).end('{"error":"unauthorized"}')
    res.writeHead(500).end(`upstream failed, sent header: ${req.headers.authorization}`)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    return await run(server.address().port, seen)
  } finally {
    server.close()
  }
}

/** Запуск настоящего `node admin.js`; значения ключа в выводе быть не может. */
async function admin(args, { port, withSecret = true }) {
  const env = { PATH: process.env.PATH, PORT: String(port) }
  if (withSecret) env[apps.admin.secretEnv] = SECRET
  const child = spawn(process.execPath, ['admin.js', ...args], {
    cwd: new URL('..', import.meta.url),
    env,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.stderr.on('data', (chunk) => (stderr += chunk))
  const code = await new Promise((resolve) => child.on('close', resolve))
  assert.ok(!stdout.includes(SECRET), 'значение ключа попало в stdout')
  assert.ok(!stderr.includes(SECRET), 'значение ключа попало в stderr')
  return { code, stdout, stderr }
}

/** Порт, на котором заведомо никто не слушает. */
async function closedPort() {
  return withServer(200, (port) => port)
}

test('200 — тело в stdout байт в байт, код 0, ключ ушёл заголовком', async () => {
  const { result, seen } = await withServer(200, async (port, seen) => ({
    result: await admin(['spend'], { port }),
    seen,
  }))
  assert.equal(result.code, 0)
  assert.equal(result.stdout, BODY_200)
  assert.equal(seen.requests, 1)
  assert.equal(seen.authorization, `Bearer ${SECRET}`)
})

test('metrics ходит по своему пути и тоже отдаёт тело', async () => {
  const result = await withServer(200, (port) => admin(['metrics'], { port }))
  assert.equal(result.code, 0)
  assert.equal(result.stdout, BODY_200)
})

test('401 от роутера — код 1', async () => {
  const result = await withServer(401, (port) => admin(['spend'], { port }))
  assert.equal(result.code, 1)
  assert.ok(result.stderr.includes('401'))
})

test('500 с эхом заголовка в теле — код 1, значение вырезано', async () => {
  const result = await withServer(500, (port) => admin(['spend'], { port }))
  assert.equal(result.code, 1)
  assert.ok(result.stderr.includes('[скрыто]'), 'эхо заголовка должно быть вырезано, а не отсутствовать')
})

for (const args of [['ledger'], ['spend', 'metrics'], [], ['constructor'], ['/v1/spend']]) {
  test(`аргумент вне закрытого множества (${JSON.stringify(args)}) — код 2, запроса нет`, async () => {
    const { result, seen } = await withServer(200, async (port, seen) => ({
      result: await admin(args, { port }),
      seen,
    }))
    assert.equal(result.code, 2)
    assert.equal(seen.requests, 0)
    assert.ok(result.stderr.includes('spend|metrics'))
  })
}

test('переменная с ключом не задана — код 2, запроса нет', async () => {
  const { result, seen } = await withServer(200, async (port, seen) => ({
    result: await admin(['spend'], { port, withSecret: false }),
    seen,
  }))
  assert.equal(result.code, 2)
  assert.equal(seen.requests, 0)
  assert.ok(result.stderr.includes(apps.admin.secretEnv))
})

test('порт без слушателя — код 1, в сообщении нет ключа', async () => {
  const result = await admin(['spend'], { port: await closedPort() })
  assert.equal(result.code, 1)
  assert.ok(result.stderr.length > 0)
})
