// Контроль расхода. Проверка предшествует вызову API, а не следует за ним
// (I-4), и суточный предел жёсткий (I-5).
//
// Состояние в памяти процесса: контейнер один, при перезапуске счётчики
// обнуляются. Это осознанный размен — SQLite ради счётчиков в однопроцессном
// приложении был бы сложнее без выигрыша.

/** Окно rate limit — оно же граница хранения IP: дольше него IP не живёт (I-10). */
const MINUTE = 60_000
const HOUR = 60 * 60_000

export function createLimiter(env, { now = () => Date.now() } = {}) {
  /** @type {Map<string, number[]>} */
  const hits = new Map()
  let day = new Date(now()).toISOString().slice(0, 10)
  let callsToday = 0

  function rollDay() {
    const today = new Date(now()).toISOString().slice(0, 10)
    if (today !== day) {
      day = today
      callsToday = 0
    }
  }

  function sweep(t) {
    for (const [ip, times] of hits) {
      const kept = times.filter((x) => t - x < HOUR)
      if (kept.length === 0) hits.delete(ip)
      else hits.set(ip, kept)
    }
  }

  return {
    /** Разрешён ли вызов API прямо сейчас. Вызывать ДО обращения к API. */
    check(ip) {
      const t = now()
      rollDay()
      sweep(t)

      if (callsToday >= env.MAX_DAILY_CALLS) {
        return {
          ok: false,
          reason: 'daily',
          message: 'Суточный лимит запросов к модели исчерпан. Попробуйте завтра.',
        }
      }

      const times = hits.get(ip) ?? []
      if (times.filter((x) => t - x < MINUTE).length >= env.RATE_LIMIT_PER_MIN) {
        return { ok: false, reason: 'minute', message: 'Слишком часто. Подождите минуту.' }
      }
      if (times.length >= env.RATE_LIMIT_PER_HOUR) {
        return {
          ok: false,
          reason: 'hour',
          message: 'Слишком много запросов за час. Попробуйте позже.',
        }
      }
      return { ok: true }
    },

    /** Отмечает состоявшийся вызов API. */
    commit(ip) {
      const t = now()
      rollDay()
      callsToday += 1
      hits.set(ip, [...(hits.get(ip) ?? []), t])
    },

    stats() {
      rollDay()
      return { callsToday, dailyLimit: env.MAX_DAILY_CALLS, trackedIps: hits.size }
    },
  }
}
