// Работы планировщика: расписание, суточный потолок и обе ручки.
// Роутер и модель не вызываются нигде: исполнитель запуска здесь подставной.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createJobs, loadJobs } from '../src/jobs/index.js'
import { nextRunAt, parseSchedule, slotsPerDay } from '../src/jobs/schedule.js'
import { createJobStore, utcDay } from '../src/jobs/store.js'

/** Работа в форме настоящего `agents/config/jobs.json` (ветка feat/scheduler-cron). */
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

function tempStore(now) {
  const dir = mkdtempSync(join(tmpdir(), 'jobs-'))
  const store = createJobStore({ file: join(dir, 'jobs.db'), now })
  return { store, clean: () => rmSync(dir, { recursive: true, force: true }) }
}

const at = (iso) => new Date(iso).getTime()

test('расписание разбирается из scheduleUtc, а следующий срок считается по UTC', () => {
  const schedule = parseSchedule('0 */6 * * *')
  assert.deepEqual(schedule.hours, [0, 6, 12, 18])
  assert.deepEqual(schedule.minutes, [0])
  assert.equal(slotsPerDay(schedule), 4)
  assert.equal(nextRunAt(schedule, at('2026-09-28T07:30:00Z')), '2026-09-28T12:00:00.000Z')
  // Через полночь: ближайший срок — следующие сутки, а не «сегодня в 0:00».
  assert.equal(nextRunAt(schedule, at('2026-09-28T18:00:01Z')), '2026-09-29T00:00:00.000Z')
  // Ровно на сроке следующий — СЛЕДУЮЩИЙ, а не этот же: иначе страница
  // показывала бы срок, который уже наступил.
  assert.equal(nextRunAt(schedule, at('2026-09-28T12:00:00Z')), '2026-09-28T18:00:00.000Z')
})

test('непонятое расписание — отказ загрузки, а не молчаливое умолчание', () => {
  assert.throws(() => parseSchedule('0 */6 * *'), /пять полей/)
  assert.throws(() => parseSchedule('0 0 1 * *'), /день месяца/)
  assert.throws(() => parseSchedule('0 H \* \* \*'), /часы/)
  assert.throws(() => parseSchedule('0 */99 * * *'), /вне диапазона/)
})

test('битая запись работ валит загрузку реестра', () => {
  assert.throws(() => loadJobs({ jobs: [] }), /непустой список/)
  assert.throws(
    () => loadJobs({ jobs: [{ ...RAW.jobs[0], enabled: 'да' }] }),
    /enabled/,
  )
  assert.throws(() => loadJobs({ jobs: [{ ...RAW.jobs[0], maxRunsPerDay: 0 }] }), /maxRunsPerDay/)
  // Потолок ниже числа сроков означал бы, что каденция сама упирается в
  // денежный потолок.
  assert.throws(
    () => loadJobs({ jobs: [{ ...RAW.jobs[0], maxRunsPerDay: 3 }] }),
    /ниже числа сроков/,
  )
})

test('седьмой старт за сутки не происходит: исполнитель не зовётся', async () => {
  let clock = at('2026-09-28T00:00:00Z')
  const { store, clean } = tempStore(() => clock)
  let calls = 0
  const jobs = createJobs({
    jobs: loadJobs(RAW),
    store,
    schedulerKey: 'ключ',
    now: () => clock,
    runJob: async () => {
      calls += 1
      return { status: 'succeeded', summary: 'готово', tokens: 10 }
    },
  })

  for (let i = 0; i < 6; i += 1) {
    const decision = jobs.trigger('digest')
    assert.equal(decision.status, 202, `старт ${i + 1}`)
    // Работа идёт: следующий старт до её конца отвергается как занятость,
    // поэтому каждый запуск здесь дожидается конца.
    await new Promise((r) => setImmediate(r))
    clock += 60_000
  }

  const seventh = jobs.trigger('digest')
  assert.equal(seventh.status, 429)
  assert.equal(seventh.body.code, 'daily_cap')
  assert.equal(seventh.body.startsToday, 6)
  assert.equal(calls, 6, 'исполнитель не зовётся седьмой раз')

  // Новые сутки UTC — счётчик начинается заново.
  clock = at('2026-09-29T00:00:00Z')
  assert.equal(jobs.trigger('digest').status, 202)
  clean()
})

test('сутки счётчика — UTC, а не пояс процесса', () => {
  // 2026-09-28T23:30Z в поясе +07:00 — уже 29-е. Ключ суток обязан остаться 28-м.
  assert.equal(utcDay(at('2026-09-28T23:30:00Z')), '2026-09-28')
  assert.equal(utcDay(at('2026-09-29T00:30:00Z')), '2026-09-29')
})

test('счётчик стартов переживает перезапуск процесса', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobs-'))
  const file = join(dir, 'jobs.db')
  const clock = at('2026-09-28T06:00:00Z')
  const first = createJobStore({ file, now: () => clock })
  first.start({ id: 'run-1', job: 'digest' })
  first.finish({ id: 'run-1', status: 'succeeded' })
  first.close()

  // Тот же файл, новый процесс: счётчик не обнулился.
  const second = createJobStore({ file, now: () => clock })
  assert.equal(second.startsToday('digest', clock), 1)
  second.close()
  rmSync(dir, { recursive: true, force: true })
})

test('три уровня выключения различимы по коду отказа', async () => {
  const clock = at('2026-09-28T06:00:00Z')
  const { store, clean } = tempStore(() => clock)
  const base = { jobs: loadJobs(RAW), store, runJob: async () => ({}), now: () => clock }

  // 1. Работа выключена в jobs.json.
  const off = createJobs({ ...base, jobs: loadJobs({ jobs: [{ ...RAW.jobs[0], enabled: false }] }), schedulerKey: 'к' })
  assert.deepEqual(off.trigger('digest'), { status: 403, body: { ok: false, code: 'disabled' } })

  // 2. Нет ключа приложения scheduler — расход по таймеру невозможен.
  const noKey = createJobs({ ...base, schedulerKey: '' })
  assert.equal(noKey.trigger('digest').status, 503)
  assert.equal(noKey.trigger('digest').body.code, 'no_scheduler_key')

  // 3. Нет тома — суточный счётчик неизвестен, запускать нельзя.
  const noStore = createJobs({ ...base, store: null, schedulerKey: 'к' })
  assert.equal(noStore.trigger('digest').body.code, 'no_store')

  // Отдельно: исполнителя ещё нет — это не успех и не «занято».
  const noExec = createJobs({ ...base, runJob: null, schedulerKey: 'к' })
  assert.equal(noExec.trigger('digest').body.code, 'no_executor')

  assert.equal(createJobs({ ...base, schedulerKey: 'к' }).trigger('нет-такой').status, 404)
  clean()
})

test('пока работа идёт, второй старт отвергается занятостью', async () => {
  const clock = at('2026-09-28T06:00:00Z')
  const { store, clean } = tempStore(() => clock)
  let release
  const jobs = createJobs({
    jobs: loadJobs(RAW),
    store,
    schedulerKey: 'к',
    now: () => clock,
    runJob: () => new Promise((r) => { release = () => r({ status: 'succeeded' }) }),
  })

  const first = jobs.trigger('digest')
  assert.equal(first.status, 202)
  // Исполнитель зовётся микрозадачей после ответа — ответ не ждёт работы.
  await new Promise((r) => setImmediate(r))
  const second = jobs.trigger('digest')
  assert.equal(second.status, 409)
  assert.equal(second.body.code, 'busy')
  assert.equal(second.body.runId, first.body.runId)

  release()
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  assert.equal(store.running('digest'), null)
  clean()
})

test('ответ отдаётся решением, а не концом работы', async () => {
  const clock = at('2026-09-28T06:00:00Z')
  const { store, clean } = tempStore(() => clock)
  let finished = false
  const jobs = createJobs({
    jobs: loadJobs(RAW),
    store,
    schedulerKey: 'к',
    now: () => clock,
    runJob: () => new Promise((r) => setTimeout(() => { finished = true; r({ status: 'succeeded' }) }, 50)),
  })

  const decision = jobs.trigger('digest')
  assert.equal(decision.status, 202)
  // Решение получено до конца работы — иначе тик планировщика ждал бы её.
  assert.equal(finished, false)
  assert.equal(store.running('digest'), decision.body.runId)
  clean()
})

test('тело сводок переводит имена конфигурации в имена экрана', async () => {
  const clock = at('2026-09-28T07:30:00Z')
  const { store, clean } = tempStore(() => clock)
  const jobs = createJobs({
    jobs: loadJobs(RAW),
    store,
    schedulerKey: 'к',
    now: () => clock,
    spend: () => ({ budgetLeftUsd: 0.42, dailyCostUsd: 0.08 }),
    runJob: async () => ({
      status: 'succeeded',
      summary: 'погода и новости',
      tokens: 1234,
      budgetLeftUsd: 0.42,
      trace: [{ server: 'mcpnews', method: 'tools/call', request: '{}', response: '{}', ms: 7 }],
    }),
  })
  jobs.trigger('digest')
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))

  const body = jobs.view('digest')
  // Экран ждёт `agent` и `schedule`; в конфигурации они `agentId` и `scheduleUtc`.
  assert.deepEqual(body.job, {
    enabled: true,
    agent: 'mcp-agent',
    schedule: '0 */6 * * *',
    maxRunsPerDay: 6,
  })
  assert.equal(body.nextRunAt, '2026-09-28T12:00:00.000Z')
  assert.equal(body.startsToday, 1)
  assert.equal(body.budgetLeftUsd, 0.42)
  assert.equal(body.dailyCostUsd, 0.08)
  assert.equal(body.running, null)
  assert.equal(body.runs.length, 1)
  assert.equal(body.runs[0].summary, 'погода и новости')
  assert.equal(body.runs[0].tokens, 1234)
  assert.equal(body.runs[0].trace[0].server, 'mcpnews')
  assert.equal(body.runs[0].status, 'succeeded')
  clean()
})

test('неизвестное не притворяется нулём: без тома startsToday — null', () => {
  const clock = at('2026-09-28T07:30:00Z')
  const jobs = createJobs({ jobs: loadJobs(RAW), store: null, schedulerKey: 'к', now: () => clock })
  const body = jobs.view('digest')

  assert.equal(body.startsToday, null)
  // То же и с деньгами: ответа роутера ещё нет — это «неизвестно», не «$0».
  assert.equal(body.budgetLeftUsd, null)
  assert.equal(body.dailyCostUsd, null)
  assert.deepEqual(body.runs, [])
  // Срок при этом известен: он считается из расписания, а не из запусков.
  assert.equal(body.nextRunAt, '2026-09-28T12:00:00.000Z')
})

test('у выключенной работы срока нет вовсе', () => {
  const clock = at('2026-09-28T07:30:00Z')
  const jobs = createJobs({
    jobs: loadJobs({ jobs: [{ ...RAW.jobs[0], enabled: false }] }),
    schedulerKey: 'к',
    now: () => clock,
  })
  assert.equal(jobs.view('digest').nextRunAt, null)
  assert.equal(jobs.view('digest').job.enabled, false)
})

test('отказ исполнителя — запуск failed, а не вечное «работа идёт»', async () => {
  const clock = at('2026-09-28T06:00:00Z')
  const { store, clean } = tempStore(() => clock)
  const jobs = createJobs({
    jobs: loadJobs(RAW),
    store,
    schedulerKey: 'к',
    now: () => clock,
    runJob: async () => {
      throw new Error('budget_exceeded')
    },
  })
  jobs.trigger('digest')
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))

  const [run] = jobs.view('digest').runs
  assert.equal(run.status, 'failed')
  assert.equal(run.summary, 'budget_exceeded')
  assert.equal(store.running('digest'), null)
  // Неудачный старт из суточного потолка НЕ вычитается: деньги на него уже
  // могли уйти, и «не получилось» не повод пробовать сверх потолка.
  assert.equal(jobs.view('digest').startsToday, 1)
  clean()
})

test('оборванный выкаткой запуск помечается на старте процесса, а не висит', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobs-'))
  const file = join(dir, 'jobs.db')
  const clock = at('2026-09-28T06:00:00Z')
  const first = createJobStore({ file, now: () => clock })
  first.start({ id: 'run-1', job: 'digest' })
  first.close()

  const second = createJobStore({ file, now: () => clock })
  assert.equal(second.running('digest'), 'run-1')
  assert.equal(second.markInterruptedOnStart(), 1)
  assert.equal(second.running('digest'), null)
  assert.equal(second.recent('digest')[0].status, 'interrupted')
  // Старт всё равно сосчитан: он был, деньги могли уйти.
  assert.equal(second.startsToday('digest', clock), 1)
  second.close()
  rmSync(dir, { recursive: true, force: true })
})
