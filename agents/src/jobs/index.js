// Работы планировщика: проверка `agents/config/jobs.json`, решение о запуске
// и тело ручки сводок (ADR 2026-09-28-0736, п. 6 и 7).
//
// Порядок решений читается сверху вниз и ровно в нём же исполняется:
// потолок стартов проверяется ДО создания запуска, а запуск создаётся ДО
// того, как начнётся работа и будет потрачен хоть один токен (I-4). Строка
// старта пишется на том: обрыв процесса посреди работы не должен стирать
// след того, что старт был — иначе выкатка обнуляла бы суточный счётчик.
//
// Ответ отдаётся РЕШЕНИЕМ, а не концом работы: тик планировщика ждёт 20
// секунд (`deploy/cron/tick.sh`), а запуск идёт минуты.

import { randomUUID } from 'node:crypto'
import { nextRunAt, parseSchedule, slotsPerDay } from './schedule.js'

const ID = /^[a-z][a-z0-9-]{1,30}$/

function fail(id, message) {
  throw new Error(`реестр работ${id ? ` (${id})` : ''}: ${message}`)
}

/** Проверяет `jobs.json` и разбирает расписание каждой работы. */
export function loadJobs(raw) {
  if (!raw || !Array.isArray(raw.jobs) || raw.jobs.length === 0)
    fail(null, 'ожидался непустой список jobs')
  const jobs = new Map()
  for (const entry of raw.jobs) {
    const id = entry?.id
    if (typeof id !== 'string' || !ID.test(id)) fail(id, 'id: латиница, цифры и дефис')
    if (jobs.has(id)) fail(id, 'идентификатор повторяется')
    for (const field of ['name', 'agentId', 'scheduleUtc'])
      if (typeof entry[field] !== 'string' || entry[field].trim() === '')
        fail(id, `${field}: ожидалась непустая строка`)
    if (typeof entry.enabled !== 'boolean') fail(id, 'enabled: ожидалось true или false')
    if (!Number.isInteger(entry.maxRunsPerDay) || entry.maxRunsPerDay <= 0)
      fail(id, 'maxRunsPerDay: ожидалось положительное целое')
    if (
      !Array.isArray(entry.prompt) ||
      entry.prompt.length === 0 ||
      entry.prompt.some((line) => typeof line !== 'string' || line.trim() === '')
    )
      fail(id, 'prompt: ожидался список непустых строк')

    const schedule = parseSchedule(entry.scheduleUtc)
    // Потолок ниже числа сроков означал бы, что ровная каденция сама
    // упирается в денежный потолок, и «всё идёт как задумано» неотличимо от
    // «упёрлись». То же требует `test/cron-schedule.test.js` от настоящего
    // `agents/config/jobs.json` — тем же `slotsPerDay`, а не своим счётом.
    if (entry.maxRunsPerDay < slotsPerDay(schedule))
      fail(id, `maxRunsPerDay ${entry.maxRunsPerDay} ниже числа сроков в сутки ${slotsPerDay(schedule)}`)

    jobs.set(id, {
      id,
      name: entry.name,
      enabled: entry.enabled,
      agentId: entry.agentId,
      maxRunsPerDay: entry.maxRunsPerDay,
      scheduleUtc: entry.scheduleUtc,
      schedule,
      prompt: entry.prompt.join(' '),
    })
  }
  return jobs
}

/**
 * Служба работ. `store` — `createJobStore` (может быть `null`: база не
 * открылась); `runJob` — исполнитель запуска, его пишет автор цикла с
 * моделью. Без исполнителя работа не стартует и это названо прямо, а не
 * притворяется успехом.
 */
export function createJobs({
  jobs,
  store = null,
  runJob = null,
  schedulerKey = null,
  spend = null,
  now = Date.now,
  log = () => {},
}) {
  /** Идёт ли работа прямо сейчас — по тому, что на томе. */
  const running = (job) => (store ? store.running(job.id) : null)

  /**
   * Решение о запуске. Возвращает `{status, body}`; работа уходит в фон
   * только при 202. Порядок проверок и есть порядок отказов.
   */
  function trigger(jobId) {
    const job = jobs.get(jobId)
    if (!job) return { status: 404, body: { ok: false, code: 'unknown_job' } }
    if (!job.enabled) return { status: 403, body: { ok: false, code: 'disabled' } }
    // Второй из трёх уровней выключения: без ключа приложения `scheduler`
    // расход по таймеру невозможен по устройству, а не по договорённости.
    if (!schedulerKey) return { status: 503, body: { ok: false, code: 'no_scheduler_key' } }
    // Без тома счётчик стартов неизвестен, а неизвестный счётчик — не ноль.
    // Запускать работу, не умея сосчитать суточный потолок, нельзя.
    if (!store) return { status: 503, body: { ok: false, code: 'no_store' } }
    if (!runJob) return { status: 503, body: { ok: false, code: 'no_executor' } }

    const busy = running(job)
    if (busy) return { status: 409, body: { ok: false, code: 'busy', runId: busy } }

    // Часовой слот выше суточного потолка (ADR 2026-09-28-0736, п. 6):
    // «шестью стартами в сутки и одним стартом в час». Без него зациклившийся
    // тик или любой держатель `AGENT_KEY` выбирает суточный потолок за
    // секунды, и экран дня 18 с 00:05 показывает «6 из 6» до конца суток —
    // суточная сумма при этом не меняется, а ограничение скорости исчезает
    // (находка гейта, PR #234). Это чтение — для ответа; держит слот
    // ограничение `UNIQUE(job, slot)`, и оно же решает гонку ниже.
    const taken = store.slotTaken(job.id, now())
    if (taken) return { status: 409, body: { ok: false, code: 'slot_taken', runId: taken } }

    const startsToday = store.startsToday(job.id, now())
    // Потолок ДО запуска, а не после (I-4).
    if (startsToday >= job.maxRunsPerDay)
      return {
        status: 429,
        body: { ok: false, code: 'daily_cap', startsToday, maxRunsPerDay: job.maxRunsPerDay },
      }

    const runId = randomUUID()
    // Строка старта пишется до работы: счётчик суток должен вырасти раньше,
    // чем будет потрачен первый токен, и пережить обрыв процесса. Слот
    // занимается здесь же: между чтением выше и этой строкой мог вклиниться
    // второй тик, и различает их только ограничение базы.
    const claimed = store.start({ id: runId, job: job.id, at: now() })
    if (!claimed.ok)
      return { status: 409, body: { ok: false, code: 'slot_taken', runId: claimed.runId } }
    log({ event: 'job_started', job: job.id, runId, startsToday: startsToday + 1 })

    // Фон: ответ уже посчитан и уйдёт тику сразу.
    Promise.resolve()
      .then(() => runJob({ job, runId }))
      .then((result = {}) =>
        store.finish({
          id: runId,
          // Статус, которого исполнитель не назвал, — НЕ «успешно»: лента дня
          // 18 показывала бы успехом то, о чём ничего не известно (правило
          // шапки `days/day18/public/digest.js`, находка гейта, PR #234).
          status: typeof result.status === 'string' && result.status !== '' ? result.status : 'failed',
          summary:
            typeof result.status === 'string' && result.status !== ''
              ? (result.summary ?? null)
              : 'исполнитель не назвал статус запуска',
          trace: result.trace ?? null,
          tokens: result.tokens ?? null,
          budgetLeftUsd: result.budgetLeftUsd ?? null,
          at: now(),
        }),
      )
      .catch((error) => {
        log({ event: 'job_failed', job: job.id, runId, error: error.message })
        try {
          store.finish({ id: runId, status: 'failed', summary: error.message, at: now() })
        } catch (secondary) {
          log({ event: 'job_finish_failed', job: job.id, runId, error: secondary.message })
        }
      })

    return { status: 202, body: { ok: true, code: 'started', runId, startsToday: startsToday + 1 } }
  }

  /**
   * Тело ручки сводок. Имена полей — те, что читает страница дня 18
   * (`days/day18/public/digest.js`): `agent` и `schedule`, тогда как в
   * конфигурации они `agentId` и `scheduleUtc`. Конфигурация чужая, поэтому
   * расхождение снимается здесь маппингом, а не переименованием в файле.
   *
   * Неизвестное остаётся неизвестным: `startsToday` без тома — `null`, а не
   * ноль. Ноль читался бы как «планировщик жив и сегодня не стартовал».
   */
  function view(jobId) {
    const job = jobs.get(jobId)
    if (!job) return null
    const spent = spend?.() ?? {}
    const runningId = store ? store.running(job.id) : null
    return {
      job: {
        enabled: job.enabled,
        agent: job.agentId,
        schedule: job.scheduleUtc,
        maxRunsPerDay: job.maxRunsPerDay,
      },
      // Срок считается из расписания работы, не из отдельной константы.
      nextRunAt: job.enabled ? nextRunAt(job.schedule, now()) : null,
      startsToday: store ? store.startsToday(job.id, now()) : null,
      budgetLeftUsd: typeof spent.budgetLeftUsd === 'number' ? spent.budgetLeftUsd : null,
      dailyCostUsd: typeof spent.dailyCostUsd === 'number' ? spent.dailyCostUsd : null,
      running: runningId === null ? null : { runId: runningId },
      runs: store ? store.recent(job.id) : [],
    }
  }

  return {
    ids: () => [...jobs.keys()],
    get: (id) => jobs.get(id) ?? null,
    trigger,
    view,
    /** Строка для `/healthz`: почему планировщик не работает, если не работает. */
    health() {
      return {
        jobs: [...jobs.values()].map((job) => ({ id: job.id, enabled: job.enabled })),
        key: schedulerKey ? 'есть' : 'нет: планировщик выключен',
        store: store ? 'есть' : 'нет: суточный счётчик недоступен',
        executor: runJob ? 'есть' : 'нет: запуск не стартует',
      }
    },
  }
}
