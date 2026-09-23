// Лимитер службы MCP: два окна на адрес, минута и час. Образец —
// `days/day15/limits.js`, но без суточного денежного счётчика: денег у этой
// службы нет, платных вызовов она не делает (ADR 2026-09-23-1227, п. 4).
//
// Проверка и учёт — один синхронный шаг, без await между ними: раздельные
// «проверить» и «посчитать» пропускали бы залп параллельных запросов мимо
// предела. Вызывать ДО исполнения `tools/call`, а не после.
//
// Состояние в памяти процесса: контейнер один, при перезапуске обнуляется.
// Окно — оно же граница хранения адреса: дольше часа адрес не живёт (I-10).

const MINUTE = 60_000
const HOUR = 60 * 60_000

export function createLimiter(env, { now = () => Date.now() } = {}) {
  /** @type {Map<string, number[]>} адрес → отметки вызовов инструментов */
  const hits = new Map()

  function sweep(t) {
    for (const [ip, times] of hits) {
      const kept = times.filter((x) => t - x < HOUR)
      if (kept.length === 0) hits.delete(ip)
      else hits.set(ip, kept)
    }
  }

  return {
    /**
     * Резервирует `count` вызовов инструментов для адреса. Либо все, либо ни
     * одного: пачка из трёх вызовов не должна начинаться, если на третий
     * слота уже не хватит.
     */
    reserve(ip, count = 1) {
      const need = Number.isInteger(count) && count > 0 ? count : 1
      const t = now()
      sweep(t)

      const times = hits.get(ip) ?? []
      if (times.filter((x) => t - x < MINUTE).length + need > env.RATE_LIMIT_PER_MIN) {
        return { ok: false, reason: 'minute', message: 'Слишком часто. Подождите минуту.' }
      }
      if (times.length + need > env.RATE_LIMIT_PER_HOUR) {
        return { ok: false, reason: 'hour', message: 'Слишком много вызовов за час. Попробуйте позже.' }
      }

      hits.set(ip, [...times, ...Array.from({ length: need }, () => t)])
      return { ok: true, reserved: need }
    },

    stats() {
      return { trackedIps: hits.size, perMinute: env.RATE_LIMIT_PER_MIN, perHour: env.RATE_LIMIT_PER_HOUR }
    },
  }
}
