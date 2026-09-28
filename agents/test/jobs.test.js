// Работы планировщика: расписание, суточный потолок и обе ручки.
// Роутер и модель не вызываются нигде: исполнитель запуска здесь подставной.

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createJobs, loadJobs } from '../src/jobs/index.js'
import { loadRegistry } from '../src/registry.js'
import { nextRunAt, parseSchedule, slotsPerDay } from '../src/jobs/schedule.js'
import { createJobStore, KEEP_RUNS, utcDay } from '../src/jobs/store.js'

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
    // поэтому каждый запуск здесь дожидается конца. Час тоже сдвигается:
    // в одном часе стартов больше одного не бывает (ADR, п. 6).
    await new Promise((r) => setImmediate(r))
    clock += 3600_000
  }

  const seventh = jobs.trigger('digest')
  assert.equal(seventh.status, 429)
  assert.equal(seventh.body.code, 'daily_cap')
  assert.equal(seventh.body.startsToday, 6)
  // Без этой строки утверждение ниже проверяло бы только код ответа:
  // исполнитель зовётся микрозадачей, и синхронный подсчёт его не видит.
  // Отказ, за которым работа всё-таки стартовала, проходил бы зелёным
  // (находка гейта, PR #234).
  await new Promise((r) => setImmediate(r))
  assert.equal(calls, 6, 'за отказом по потолку не стартовало ничего')

  // Новые сутки UTC — счётчик начинается заново (и час там свой).
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

// Тест выше ловит подмену UTC на местное время только тогда, когда пояс
// прогона не UTC, — а в контейнере он как раз UTC. Поэтому держатель у этого
// правила механический: в коде суток нет ни одного обращения к местному
// времени. Снять `getUTC*` не выйдет незаметно ни при каком поясе прогона.
test('день суток считается только по UTC: местного времени в коде нет', () => {
  const source = readFileSync(new URL('../src/jobs/store.js', import.meta.url), 'utf8')
  const local = source.match(/\.get(FullYear|Month|Date|Hours|Minutes|Day)\(/g) ?? []
  assert.deepEqual(local, [], `местное время в src/jobs/store.js: ${local.join(', ')}`)
  assert.match(source, /getUTCFullYear/)
})

test('уборка ленты сводок не трогает суточный счётчик стартов', () => {
  // Пока счётчик считал строки ленты, `pruneOld` (50 последних строк ПО ВСЕМ
  // работам) занижал счётчик каждой работы чужими стартами (находка гейта,
  // PR #234). Одной работой это теперь недостижимо — часовой слот держит её
  // в пределах 24 стартов в сутки, — но несколько работ ADR допускает, и
  // именно так дефект и воспроизводится.
  let clock = at('2026-09-28T00:00:00Z')
  const { store, clean } = tempStore(() => clock)
  const jobs = ['digest', 'вторая', 'третья', 'четвёртая', 'пятая']
  let n = 0
  for (let hour = 0; hour < 12; hour += 1) {
    clock = at('2026-09-28T00:00:00Z') + hour * 3600_000
    for (const job of jobs) {
      n += 1
      store.start({ id: `run-${n}`, job })
      store.finish({ id: `run-${n}`, status: 'succeeded' })
    }
  }

  // Строк в ленте 60, уборка оставила 50 — и это её дело, а не счётчика.
  assert.equal(store.recent('digest').length + store.recent('вторая').length <= KEEP_RUNS, true)
  // Счётчик каждой работы цел и чужими стартами не занижен.
  for (const job of jobs) assert.equal(store.startsToday(job, clock), 12, job)
  clean()
})

test('счётчик прошлых суток не держится вечно, а нынешние сутки уборка не трогает', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobs-'))
  const file = join(dir, 'jobs.db')
  let clock = at('2026-09-01T06:00:00Z')
  const store = createJobStore({ file, now: () => clock })
  store.start({ id: 'старый', job: 'digest' })

  clock = at('2026-09-20T06:00:00Z')
  store.start({ id: 'новый', job: 'digest' })
  assert.equal(store.startsToday('digest', at('2026-09-01T06:00:00Z')), 0, 'давние сутки убраны')
  assert.equal(store.startsToday('digest', clock), 1, 'нынешние сутки целы')

  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('срок в теле сводок меняется вместе с часами и с расписанием работы', () => {
  // Держатель ПРОВОДКИ, а не самой `nextRunAt`: подмена вызова на литерал
  // проходила незамеченной, потому что оба теста тела читали один и тот же
  // час и одно и то же расписание (находка гейта, PR #234).
  const make = (scheduleUtc, nowIso) =>
    createJobs({
      jobs: loadJobs({ jobs: [{ ...RAW.jobs[0], scheduleUtc, maxRunsPerDay: 30 }] }),
      schedulerKey: 'к',
      now: () => at(nowIso),
    }).view('digest')

  // Одно расписание, разные часы — разные сроки.
  assert.equal(make('0 */6 * * *', '2026-09-28T07:30:00Z').nextRunAt, '2026-09-28T12:00:00.000Z')
  assert.equal(make('0 */6 * * *', '2026-09-28T13:05:00Z').nextRunAt, '2026-09-28T18:00:00.000Z')
  // Один час, разные расписания — разные сроки.
  assert.equal(make('0 */2 * * *', '2026-09-28T07:30:00Z').nextRunAt, '2026-09-28T08:00:00.000Z')
  assert.equal(make('30 9 * * *', '2026-09-28T07:30:00Z').nextRunAt, '2026-09-28T09:30:00.000Z')
  // И срок работы — это её собственное расписание, а не чужое.
  assert.equal(make('30 9 * * *', '2026-09-28T07:30:00Z').job.schedule, '30 9 * * *')
})

test('второй старт в том же часе UTC отвергается слотом, а не потолком', async () => {
  let clock = at('2026-09-28T06:00:00Z')
  const { store, clean } = tempStore(() => clock)
  let calls = 0
  const jobs = createJobs({
    jobs: loadJobs(RAW),
    store,
    schedulerKey: 'к',
    now: () => clock,
    runJob: async () => {
      calls += 1
      return { status: 'succeeded' }
    },
  })

  assert.equal(jobs.trigger('digest').status, 202)
  await new Promise((r) => setImmediate(r))

  // Тот же час, работа уже закончилась: это не занятость.
  clock = at('2026-09-28T06:59:59Z')
  const second = jobs.trigger('digest')
  assert.equal(second.status, 409)
  assert.equal(second.body.code, 'slot_taken')
  await new Promise((r) => setImmediate(r))
  assert.equal(calls, 1, 'за отказом по слоту не стартовало ничего')
  // Суточный потолок при этом не тронут: отказ именно часовой.
  assert.equal(jobs.view('digest').startsToday, 1)

  // Следующий час — можно.
  clock = at('2026-09-28T07:00:00Z')
  assert.equal(jobs.trigger('digest').status, 202)
  clean()
})

test('слот держит ограничение базы, а не проверка чтением', () => {
  const clock = at('2026-09-28T06:30:00Z')
  const { store, clean } = tempStore(() => clock)
  assert.deepEqual(store.start({ id: 'a', job: 'digest' }), { ok: true, runId: 'a' })
  // Прямой вызов минуя чтение — так выглядит второй тик, вклинившийся между
  // проверкой и записью.
  const second = store.start({ id: 'b', job: 'digest' })
  assert.deepEqual(second, { ok: false, code: 'slot_taken', runId: 'a' })
  // Отвергнутый старт не сосчитан и строки ленты не оставил.
  assert.equal(store.startsToday('digest', clock), 1)
  assert.equal(store.recent('digest').length, 1)
  clean()
})

test('час у каждой работы свой', () => {
  const clock = at('2026-09-28T06:30:00Z')
  const { store, clean } = tempStore(() => clock)
  assert.equal(store.start({ id: 'a', job: 'digest' }).ok, true)
  assert.equal(store.start({ id: 'b', job: 'other' }).ok, true)
  assert.equal(store.slotTaken('digest', clock), 'a')
  assert.equal(store.slotTaken('other', clock), 'b')
  clean()
})

test('исполнитель без статуса — отказ, а не молчаливый успех', async () => {
  const clock = at('2026-09-28T06:00:00Z')
  const { store, clean } = tempStore(() => clock)
  const jobs = createJobs({
    jobs: loadJobs(RAW),
    store,
    schedulerKey: 'к',
    now: () => clock,
    // Исполнитель вернул сводку, но статуса не назвал.
    runJob: async () => ({ summary: 'что-то получилось', tokens: 10 }),
  })
  jobs.trigger('digest')
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))

  const [run] = jobs.view('digest').runs
  assert.equal(run.status, 'failed')
  assert.equal(run.summary, 'исполнитель не назвал статус запуска')
  clean()
})

test('час занят и потолок выбран — отказ называет слот, а не потолок', async () => {
  // Порядок проверок наблюдаем именно здесь: обе причины истинны сразу, и
  // ручка обязана назвать более узкую — часовую (ADR 2026-09-28-0736, п. 6).
  // Без чтения слота выше потолка ответ говорил бы `daily_cap`, то есть
  // «на сегодня всё», тогда как на деле ждать надо до следующего часа.
  let clock = at('2026-09-28T00:00:00Z')
  const { store, clean } = tempStore(() => clock)
  const jobs = createJobs({
    jobs: loadJobs(RAW),
    store,
    schedulerKey: 'к',
    now: () => clock,
    runJob: async () => ({ status: 'succeeded' }),
  })

  for (let hour = 0; hour < 6; hour += 1) {
    clock = at('2026-09-28T00:00:00Z') + hour * 3600_000
    assert.equal(jobs.trigger('digest').status, 202, `час ${hour}`)
    await new Promise((r) => setImmediate(r))
  }

  // Шестой час уже использован, и суточный потолок 6 тоже выбран.
  const both = jobs.trigger('digest')
  assert.equal(both.status, 409)
  assert.equal(both.body.code, 'slot_taken')

  // А в следующем часе остаётся только потолок — и он называется.
  clock = at('2026-09-28T06:00:00Z')
  const capped = jobs.trigger('digest')
  assert.equal(capped.status, 429)
  assert.equal(capped.body.code, 'daily_cap')
  clean()
})

test('запрос работы к агенту без модели — латиницей (настоящие jobs.json и agents.json)', () => {
  // Настоящие конфиги через настоящие разборщики, без сети — тем же приёмом,
  // что и `test/cron-schedule.test.js`.
  //
  // Из какого отказа. Плановая работа дня 18 несла запрос по-русски, и первый
  // же прогон цепочки дня 19 в проде остановился на news.search с reason
  // `empty`: источник (Hacker News через Algolia) англоязычен. Код был верен —
  // неверно было содержимое запроса.
  //
  // ПРЕДЕЛ этой проверки, названный честно: она кодирует «источник
  // английский» как замену настоящему правилу «язык запроса = язык
  // источника». При неанглоязычном источнике она станет неверной, и
  // находимости запроса («вернёт ли поиск хоть что-нибудь») не доказывает
  // вовсе — такой тест означал бы живой поход к чужому API. Это защита от
  // возврата бага, а не доказательство свойства; возврат правдоподобен —
  // каждая другая строка в `jobs.json` по-русски.
  //
  // Только работы к агенту БЕЗ модели: их запрос уходит в инструмент как
  // есть. У работы с моделью язык запроса ничем не ограничен — модель сама
  // решает, что искать, и связывать ей руки здесь нечем и незачем.
  const read = (name) => JSON.parse(readFileSync(new URL(`../config/${name}`, import.meta.url), 'utf8'))
  const jobs = loadJobs(read('jobs.json'))
  const agents = loadRegistry(read('agents.json'))

  const modelless = [...jobs.values()].filter((job) => agents.get(job.agentId)?.modelless)
  assert.ok(
    modelless.length > 0,
    'ни одна работа не адресована агенту без модели — проверка не держит ничего, и это находка, а не успех',
  )
  for (const job of modelless)
    assert.ok(
      !/\p{Script=Cyrillic}/u.test(job.prompt),
      `работа ${job.id}: запрос уходит в инструмент как есть, кириллица в нём ничего не найдёт — ${job.prompt}`,
    )
})
