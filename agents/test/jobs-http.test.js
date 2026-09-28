// Обе ручки планировщика через настоящий HTTP: авторизация, коды решений и
// тело сводок. Роутер, модель и cron не участвуют — исполнитель подставной.

import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createJobs, loadJobs } from '../src/jobs/index.js'
import { createJobStore } from '../src/jobs/store.js'
import { createRuns } from '../src/runs.js'
import { createService } from '../src/service.js'
import { ENV, fakeArchive } from './fixtures.js'

const RAW = {
  jobs: [
    {
      id: 'digest',
      name: 'Сводка',
      enabled: true,
      agentId: 'mcp-agent',
      maxRunsPerDay: 6,
      scheduleUtc: '0 */6 * * *',
      prompt: ['Собери короткую сводку.'],
    },
  ],
}

const clock = new Date('2026-09-28T07:30:00Z').getTime()
const dir = mkdtempSync(join(tmpdir(), 'jobs-http-'))
const store = createJobStore({ file: join(dir, 'jobs.db'), now: () => clock })
/** Что видел исполнитель: доказательство, что работа стартовала, а не «200 и всё». */
const started = []
const jobs = createJobs({
  jobs: loadJobs(RAW),
  store,
  schedulerKey: 'ключ-планировщика',
  now: () => clock,
  runJob: async ({ job, runId }) => {
    started.push({ job: job.id, runId })
    return { status: 'succeeded', summary: 'погода и новости', tokens: 900, budgetLeftUsd: 0.4 }
  },
})

const server = http.createServer(
  createService({ agents: new Map(), archive: fakeArchive(), runs: createRuns(), jobs, env: ENV, log: () => {} }),
)
let base = ''

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(async () => {
  await new Promise((resolve) => server.close(resolve))
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const AUTH = { authorization: 'Bearer agent-key' }

test('обе ручки закрыты ключом сервиса', async () => {
  const noKey = await fetch(`${base}/v1/jobs/digest`)
  assert.equal(noKey.status, 401)
  const wrong = await fetch(`${base}/v1/jobs/digest/trigger`, {
    method: 'POST',
    headers: { authorization: 'Bearer wrong-key' },
  })
  assert.equal(wrong.status, 401)
  // Без ключа не стартует ничего: журнал стенда пуст.
  assert.deepEqual(started, [])
})

test('запуск отвечает 202 решением, и работа действительно стартует', async () => {
  const response = await fetch(`${base}/v1/jobs/digest/trigger`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(response.status, 202)
  const body = await response.json()
  assert.equal(body.code, 'started')
  assert.equal(body.startsToday, 1)

  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  // Доказательство доставки — запись исполнителя, а не код ответа.
  assert.deepEqual(started, [{ job: 'digest', runId: body.runId }])
})

test('сводки отдаются в именах экрана дня 18', async () => {
  const response = await fetch(`${base}/v1/jobs/digest`, { headers: AUTH })
  assert.equal(response.status, 200)
  const body = await response.json()

  assert.deepEqual(body.job, {
    enabled: true,
    agent: 'mcp-agent',
    schedule: '0 */6 * * *',
    maxRunsPerDay: 6,
  })
  assert.equal(body.nextRunAt, '2026-09-28T12:00:00.000Z')
  assert.equal(body.startsToday, 1)
  assert.equal(body.running, null)
  assert.equal(body.runs[0].summary, 'погода и новости')
  assert.equal(body.runs[0].tokens, 900)
  // Ответа роутера о расходе ещё нет: «неизвестно», а не ноль.
  assert.equal(body.dailyCostUsd, null)
})

test('неизвестная работа — 404, а не пустая сводка', async () => {
  const response = await fetch(`${base}/v1/jobs/нет-такой`, { headers: AUTH })
  assert.equal(response.status, 404)
  const trigger = await fetch(`${base}/v1/jobs/other/trigger`, { method: 'POST', headers: AUTH })
  assert.equal(trigger.status, 404)
  assert.equal((await trigger.json()).code, 'unknown_job')
})

test('/healthz называет состояние планировщика порознь и без секретов', async () => {
  const response = await fetch(`${base}/healthz`)
  const body = await response.json()

  assert.equal(body.scheduler.key, 'есть')
  assert.equal(body.scheduler.store, 'есть')
  assert.equal(body.scheduler.executor, 'есть')
  assert.deepEqual(body.scheduler.jobs, [{ id: 'digest', enabled: true }])
  // Ключа в ответе нет ни в каком виде.
  assert.ok(!JSON.stringify(body).includes('ключ-планировщика'))
})
