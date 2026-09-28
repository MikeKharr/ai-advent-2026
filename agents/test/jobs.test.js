// Работы планировщика: расписание, суточный потолок и обе ручки.
// Роутер и модель не вызываются нигде: исполнитель запуска здесь подставной.

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createJobs, loadJobs } from '../src/jobs/index.js'
import { lastDueAt, nextRunAt, parseSchedule, slotsPerDay } from '../src/jobs/schedule.js'
import { createJobStore, KEEP_RUNS, STARTS_KEEP_DAYS, utcDay } from '../src/jobs/store.js'

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

/**
 * Вторая работа — с НАСТОЯЩЕЙ каденцией дня 18 (`*\/15`). Она и различает слот
 * по сроку от прежнего часового: в одном часе у неё четыре срока, и второй
 * старт в 06:15 обязан пройти, а в 06:07 — нет.
 */
const RAW15 = {
  jobs: [{ ...RAW.jobs[0], agentId: 'pipeline-agent', maxRunsPerDay: 96, scheduleUtc: '*/15 * * * *' }],
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

test('потолок стартов за сутки проверяется ДО исполнителя: он не зовётся (I-4)', async () => {
  // При слоте-сроке ровная каденция в потолок не упирается: сроков в сутки
  // столько же, сколько потолок (ADR 2026-09-28-1323, п. 3 — потолок здесь
  // ВТОРОЙ держатель, а не рабочий предел). Достижим он остаётся другим
  // путём: счётчик стартов живёт на томе и переживает и смену каденции
  // посреди суток, и ручные старты. Этот путь и проверяется — потому что
  // порядок «потолок раньше вызова» и есть I-4.
  let clock = at('2026-09-28T06:00:00Z')
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

  // Шесть стартов уже накоплены — слотами, которых нынешнее расписание не
  // даёт (так выглядят те же сутки до смены каденции).
  for (let i = 0; i < 6; i += 1) {
    store.start({ id: `прежний-${i}`, job: 'digest', slot: `2026-09-28T0${i}:05:00.000Z` })
    store.finish({ id: `прежний-${i}`, status: 'succeeded' })
  }
  assert.equal(store.startsToday('digest', clock), 6)

  // Свободный срок есть — 06:00 никем не занят, — и всё равно отказ.
  assert.equal(store.slotTaken('digest', '2026-09-28T06:00:00.000Z'), null)
  const capped = jobs.trigger('digest')
  assert.equal(capped.status, 429)
  assert.equal(capped.body.code, 'daily_cap')
  assert.equal(capped.body.startsToday, 6)
  // Без этой строки утверждение ниже проверяло бы только код ответа:
  // исполнитель зовётся микрозадачей, и синхронный подсчёт его не видит.
  // Отказ, за которым работа всё-таки стартовала, проходил бы зелёным
  // (находка гейта, PR #234).
  await new Promise((r) => setImmediate(r))
  assert.equal(calls, 0, 'за отказом по потолку не стартовало ничего')

  // Новые сутки UTC — счётчик начинается заново (и срок там свой).
  clock = at('2026-09-29T00:00:00Z')
  assert.equal(jobs.trigger('digest').status, 202)
  // `calls === 0` выше доказывает, что за отказом ничего не стартовало, но
  // САМ ПО СЕБЕ он остаётся верным и когда исполнитель недостижим вовсе:
  // прежняя редакция теста несла это доказательство в себе счётчиком до
  // потолка, перестроенная — потеряла (находка гейта к этому же PR).
  // Строка ниже возвращает его: разрешённый старт обязан позвать исполнителя.
  await new Promise((r) => setImmediate(r))
  assert.equal(calls, 1, 'разрешённый старт зовёт исполнителя — иначе ноль выше ничего не значит')
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
  first.start({ id: 'run-1', job: 'digest', slot: '2026-09-28T06:00:00.000Z' })
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
  first.start({ id: 'run-1', job: 'digest', slot: '2026-09-28T06:00:00.000Z' })
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
      store.start({ id: `run-${n}`, job, slot: `2026-09-28T${String(hour).padStart(2, '0')}:00:00.000Z` })
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
  store.start({ id: 'старый', job: 'digest', slot: '2026-09-01T06:00:00.000Z' })

  clock = at('2026-09-20T06:00:00Z')
  store.start({ id: 'новый', job: 'digest', slot: '2026-09-20T06:00:00.000Z' })
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

test('второй тик в том же сроке — 409 slot_taken, следующий срок — 202', async () => {
  // Предмет — именно СРОК, а не час: у `*/15` в одном часе четыре срока.
  // На часовом слоте 06:15 отвечал бы 409, и каденция не ускоряла бы работу,
  // а давала отказ на каждом лишнем тике (ADR 2026-09-28-1323, п. 2).
  let clock = at('2026-09-28T06:00:00Z')
  const { store, clean } = tempStore(() => clock)
  let calls = 0
  const jobs = createJobs({
    jobs: loadJobs(RAW15),
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

  // Тот же срок, работа уже закончилась: это не занятость.
  clock = at('2026-09-28T06:07:00Z')
  const second = jobs.trigger('digest')
  assert.equal(second.status, 409)
  assert.equal(second.body.code, 'slot_taken')
  await new Promise((r) => setImmediate(r))
  assert.equal(calls, 1, 'за отказом по слоту не стартовало ничего')
  // Суточный потолок при этом не тронут: отказ именно по сроку.
  assert.equal(jobs.view('digest').startsToday, 1)

  // Следующий срок — можно, и это тот же час.
  clock = at('2026-09-28T06:15:00Z')
  assert.equal(jobs.trigger('digest').status, 202, 'срок 06:15 отвергнут — слот считается не по сроку')
  await new Promise((r) => setImmediate(r))
  assert.equal(calls, 2)
  assert.equal(jobs.view('digest').startsToday, 2)
  clean()
})

test('ручной старт после пропущенного тика — 202: свободный срок остаётся свободным', async () => {
  // Тик 06:15 не пришёл (контейнер времени лежал). Догнать его руками можно —
  // срок не занят; повторно тем же сроком — уже нет.
  let clock = at('2026-09-28T06:00:00Z')
  const { store, clean } = tempStore(() => clock)
  const jobs = createJobs({
    jobs: loadJobs(RAW15),
    store,
    schedulerKey: 'к',
    now: () => clock,
    runJob: async () => ({ status: 'succeeded' }),
  })

  assert.equal(jobs.trigger('digest').status, 202)
  await new Promise((r) => setImmediate(r))

  clock = at('2026-09-28T06:29:00Z')
  assert.equal(jobs.trigger('digest').status, 202, 'пропущенный срок 06:15 догнать руками нельзя')
  await new Promise((r) => setImmediate(r))
  // Занят именно срок 06:15, а не минута нажатия.
  assert.notEqual(store.slotTaken('digest', '2026-09-28T06:15:00.000Z'), null)
  const again = jobs.trigger('digest')
  assert.equal(again.status, 409)
  assert.equal(again.body.code, 'slot_taken')
  clean()
})

test('lastDueAt и nextRunAt дают один и тот же ряд сроков', () => {
  // Зеркальность проверяется ИСПОЛНЕНИЕМ, а не чтением: разойдись ряды —
  // слот занимал бы не тот срок, что обещан экрану, и покраснеть было бы
  // нечему. Сутки прогоняются целиком, по трём каденциям.
  for (const text of ['*/15 * * * *', '0 */6 * * *', '30 9 * * *', '0,17,45 * * * *']) {
    const schedule = parseSchedule(text)
    const seen = []
    let cursor = at('2026-09-28T00:00:00Z') - 60_000
    for (;;) {
      const next = nextRunAt(schedule, cursor)
      if (Date.parse(next) >= at('2026-09-29T00:00:00Z')) break
      seen.push(next)
      cursor = Date.parse(next)
    }
    assert.equal(seen.length, slotsPerDay(schedule), `${text}: сроков за сутки не столько`)

    // Ровно на сроке последний наступивший — он сам.
    for (const due of seen) assert.equal(lastDueAt(schedule, Date.parse(due)), due, `${text} ровно на ${due}`)
    // В любую минуту суток последний наступивший — ближайший срок слева, и он
    // из того же ряда: иначе сроков нашлось бы больше, чем их есть.
    const set = new Set(seen)
    for (let m = 0; m < 24 * 60; m += 1) {
      const t = at('2026-09-28T00:00:00Z') + m * 60_000
      const last = lastDueAt(schedule, t + 59_000)
      assert.ok(Date.parse(last) <= t + 59_000, `${text}: ${last} позже минуты ${m}`)
      const nextAfterLast = nextRunAt(schedule, Date.parse(last))
      assert.ok(Date.parse(nextAfterLast) > t, `${text}: между ${last} и минутой ${m} есть пропущенный срок`)
      if (Date.parse(last) >= at('2026-09-28T00:00:00Z'))
        assert.ok(set.has(last), `${text}: ${last} не из ряда nextRunAt`)
    }
  }
})

test('слот держит ограничение базы, а не проверка чтением', () => {
  const clock = at('2026-09-28T06:30:00Z')
  const { store, clean } = tempStore(() => clock)
  const slot = '2026-09-28T06:30:00.000Z'
  assert.deepEqual(store.start({ id: 'a', job: 'digest', slot }), { ok: true, runId: 'a' })
  // Прямой вызов минуя чтение — так выглядит второй тик, вклинившийся между
  // проверкой и записью.
  const second = store.start({ id: 'b', job: 'digest', slot })
  assert.deepEqual(second, { ok: false, code: 'slot_taken', runId: 'a' })
  // Отвергнутый старт не сосчитан и строки ленты не оставил.
  assert.equal(store.startsToday('digest', clock), 1)
  assert.equal(store.recent('digest').length, 1)
  clean()
})

test('срок у каждой работы свой', () => {
  const clock = at('2026-09-28T06:30:00Z')
  const { store, clean } = tempStore(() => clock)
  const slot = '2026-09-28T06:30:00.000Z'
  assert.equal(store.start({ id: 'a', job: 'digest', slot }).ok, true)
  assert.equal(store.start({ id: 'b', job: 'other', slot }).ok, true)
  assert.equal(store.slotTaken('digest', slot), 'a')
  assert.equal(store.slotTaken('other', slot), 'b')
  clean()
})

test('уборка слотов режет по суткам, а не по строке', () => {
  // `pruneSlots` сравнивает ISO-слот с ключом суток `YYYY-MM-DD`
  // лексикографически. Читается это верно, но проверено ИСПОЛНЕНИЕМ: сутки
  // среза обязаны остаться целиком, включая слот 00:00, а более ранние уйти.
  let clock = at('2026-09-01T06:00:00Z')
  const { store, clean } = tempStore(() => clock)
  const cutoffDay = utcDay(at('2026-09-28T06:00:00Z') - STARTS_KEEP_DAYS * 24 * 3600_000)
  assert.equal(cutoffDay, '2026-09-21')

  store.start({ id: 'давний', job: 'digest', slot: '2026-09-20T23:45:00.000Z' })
  store.start({ id: 'край', job: 'digest', slot: `${cutoffDay}T00:00:00.000Z` })

  // Старт «сегодня» запускает уборку срезом `2026-09-21`.
  clock = at('2026-09-28T06:00:00Z')
  store.start({ id: 'нынешний', job: 'digest', slot: '2026-09-28T06:00:00.000Z' })

  assert.equal(store.slotTaken('digest', '2026-09-20T23:45:00.000Z'), null, 'давний слот не убран')
  assert.equal(
    store.slotTaken('digest', `${cutoffDay}T00:00:00.000Z`),
    'край',
    'слот суток среза убран: сравнение съело целые сутки',
  )
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

test('срок занят и потолок выбран — отказ называет слот, а не потолок', async () => {
  // Порядок проверок наблюдаем именно здесь: обе причины истинны сразу, и
  // ручка обязана назвать более узкую — срок (ADR 2026-09-28-1323, п. 2).
  // Без чтения слота выше потолка ответ говорил бы `daily_cap`, то есть
  // «на сегодня всё», тогда как на деле ждать надо до следующего срока.
  let clock = at('2026-09-28T06:00:00Z')
  const { store, clean } = tempStore(() => clock)
  const jobs = createJobs({
    jobs: loadJobs(RAW),
    store,
    schedulerKey: 'к',
    now: () => clock,
    runJob: async () => ({ status: 'succeeded' }),
  })

  // Потолок 6 выбран накопленными стартами, и срок 06:00 занят одним из них.
  for (let i = 0; i < 5; i += 1) {
    store.start({ id: `прежний-${i}`, job: 'digest', slot: `2026-09-28T0${i}:05:00.000Z` })
    store.finish({ id: `прежний-${i}`, status: 'succeeded' })
  }
  store.start({ id: 'этот-срок', job: 'digest', slot: '2026-09-28T06:00:00.000Z' })
  store.finish({ id: 'этот-срок', status: 'succeeded' })
  assert.equal(store.startsToday('digest', clock), 6)

  const both = jobs.trigger('digest')
  assert.equal(both.status, 409)
  assert.equal(both.body.code, 'slot_taken')
  assert.equal(both.body.runId, 'этот-срок')

  // А на следующем сроке остаётся только потолок — и он называется.
  clock = at('2026-09-28T12:00:00Z')
  const capped = jobs.trigger('digest')
  assert.equal(capped.status, 429)
  assert.equal(capped.body.code, 'daily_cap')
  clean()
})
