// Контроль расхода. Слот резервируется ДО вызова API одним синхронным шагом
// (I-4): раздельные «проверить» и «посчитать» с await между ними пропускали
// залп параллельных запросов мимо суточного предела (I-5) — все видели
// счётчик до первого учёта.
//
// Состояние в памяти процесса: контейнер один, при перезапуске счётчики
// обнуляются. Это осознанный размен — SQLite ради счётчиков в однопроцессном
// приложении был бы сложнее без выигрыша.
//
// У дня 15, как и у дней 11 и 13, два окна на адрес (ADR 2026-09-15-2024, п. 8.3):
// запуски — как в дне 10, и отдельно записи профиля. Записи модель не зовут,
// но это публичные ручки, меняющие общую для всех память: создание и
// удаление профиля, выбор, настройки, ответ о теме. Второе окно нужно именно
// потому, что первое считает запуски, — без него создание и стирание чужих
// профилей не упиралось бы ни во что.
//
// Новое против дня 11: слот берётся не по одному. Круг проверки сверх первого —
// ещё один платный ответ и ещё одна платная проверка, поэтому сообщение
// резервирует `reviewRounds` слотов разом (ADR 2026-09-21-1747, п. 5), а
// неиспользованные возвращаются по завершении запуска. Проверка и учёт всех
// слотов — по-прежнему один синхронный шаг: частичная выдача («дали два из
// трёх») означала бы, что пределы держат меньше, чем обещали.

/** Окно rate limit — оно же граница хранения IP: дольше него IP не живёт (I-10). */
const MINUTE = 60_000
const HOUR = 60 * 60_000

export function createLimiter(env, { now = () => Date.now() } = {}) {
  /** @type {Map<string, number[]>} адрес → отметки запусков */
  const hits = new Map()
  /** @type {Map<string, number[]>} адрес → отметки записей профиля */
  const writes = new Map()
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
    for (const map of [hits, writes]) {
      for (const [ip, times] of map) {
        const kept = times.filter((x) => t - x < HOUR)
        if (kept.length === 0) map.delete(ip)
        else map.set(ip, kept)
      }
    }
  }

  return {
    /**
     * Резервирует `count` слотов вызова API: проверка и учёт — один синхронный
     * шаг, без await между ними. Вызывать ДО обращения к API. Либо все слоты,
     * либо ни одного: сообщение с пределом кругов 3 не должно начинаться,
     * если на третий круг слота уже не хватит.
     */
    reserve(ip, count = 1) {
      const need = Number.isInteger(count) && count > 0 ? count : 1
      const t = now()
      rollDay()
      sweep(t)

      if (callsToday + need > env.MAX_DAILY_CALLS) {
        return {
          ok: false,
          reason: 'daily',
          message: 'Суточный лимит запросов к модели исчерпан. Попробуйте завтра.',
        }
      }

      const times = hits.get(ip) ?? []
      if (times.filter((x) => t - x < MINUTE).length + need > env.RATE_LIMIT_PER_MIN) {
        return { ok: false, reason: 'minute', message: 'Слишком часто. Подождите минуту.' }
      }
      if (times.length + need > env.RATE_LIMIT_PER_HOUR) {
        return {
          ok: false,
          reason: 'hour',
          message: 'Слишком много запросов за час. Попробуйте позже.',
        }
      }

      callsToday += need
      hits.set(ip, [...times, ...Array.from({ length: need }, () => t)])
      return { ok: true, reserved: need }
    },

    /**
     * Резервирует запись профиля: то же правило «проверить и посчитать одним
     * шагом», своё окно и свой счётчик. Слот записи не возвращается: она уже
     * состоялась или отклонена сервисом, добирать нечего.
     */
    reserveWrite(ip) {
      const t = now()
      rollDay()
      sweep(t)

      const times = writes.get(ip) ?? []
      if (times.length >= env.RATE_LIMIT_WRITES_PER_HOUR) {
        return {
          ok: false,
          reason: 'writes',
          message: 'Слишком много изменений профилей за час. Попробуйте позже.',
        }
      }
      writes.set(ip, [...times, t])
      return { ok: true }
    },

    /**
     * Возвращает `count` зарезервированных слотов, если вызовов API не
     * случилось: запуск отвергнут до запроса или кругов проверки сделано
     * меньше, чем зарезервировано. Ошибка самого вызова слот НЕ возвращает:
     * запрос мог дойти до API, считаем его потраченным.
     */
    release(ip, count = 1) {
      const back = Number.isInteger(count) && count > 0 ? count : 1
      rollDay()
      const times = hits.get(ip) ?? []
      // Возвращается не больше, чем занято: иначе пометка «круг не состоялся»
      // от агента чинила бы счётчик чужих запусков.
      const n = Math.min(back, callsToday, times.length)
      callsToday -= n
      times.length = Math.max(0, times.length - n)
      if (times.length === 0) hits.delete(ip)
      else hits.set(ip, times)
    },

    stats() {
      rollDay()
      return {
        callsToday,
        dailyLimit: env.MAX_DAILY_CALLS,
        trackedIps: hits.size,
        writeIps: writes.size,
      }
    },
  }
}
