// Контроль расхода. Слот резервируется ДО вызова API одним синхронным шагом
// (I-4): раздельные «проверить» и «посчитать» с await между ними пропускали
// залп параллельных запросов мимо суточного предела (I-5) — все видели
// счётчик до первого учёта.
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
    /**
     * Резервирует слот вызова API: проверка и учёт — один синхронный шаг,
     * без await между ними. Вызывать ДО обращения к API.
     */
    reserve(ip) {
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

      callsToday += 1
      hits.set(ip, [...times, t])
      return { ok: true }
    },

    /**
     * Возвращает зарезервированный слот, если вызова API не случилось
     * (например, ленты пустые). Ошибка самого вызова слот НЕ возвращает:
     * запрос мог дойти до API, считаем его потраченным.
     */
    release(ip) {
      rollDay()
      if (callsToday > 0) callsToday -= 1
      const times = hits.get(ip)
      if (times && times.length > 0) {
        times.pop()
        if (times.length === 0) hits.delete(ip)
        else hits.set(ip, times)
      }
    },

    stats() {
      rollDay()
      return { callsToday, dailyLimit: env.MAX_DAILY_CALLS, trackedIps: hits.size }
    },
  }
}
