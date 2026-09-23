// Лимитер дня 16 — по образцу days/day15/limits.js, с двумя отличиями,
// каждое названо:
//
// 1. **Суточного денежного счётчика нет.** У дней 6–15 он считает платные
//    вызовы модели; служба MCP денег не стоит, и счётчик, который ничего не
//    охраняет, читался бы как охрана. Окна на адрес остаются: они защищают
//    чужие API (Open-Meteo, Wikimedia), к которым ходят инструменты службы с
//    нашего единственного адреса (ADR 2026-09-23-1227, «Последствия»).
// 2. **Отказ несёт число секунд до повтора.** Требование раскладки
//    (2026-09-23-1242, п. 17.3): строка состояния страницы обязана назвать,
//    когда можно повторить, а вывести это число из «слишком часто» нельзя.
//
// Проверка и учёт — по-прежнему один синхронный шаг без await между ними
// (I-4): раздельные «проверить» и «посчитать» пропускают залп параллельных
// запросов мимо окна.
//
// Состояние в памяти процесса: контейнер один, при перезапуске счётчики
// обнуляются. Окно — оно же граница хранения адреса: дольше часа IP не живёт (I-10).

const MINUTE = 60_000
const HOUR = 60 * 60_000

/**
 * Через сколько секунд освободится слот: столько, сколько осталось жить самой
 * ранней отметке в окне. Именно она уйдёт первой и даст место следующей.
 *
 * Ноля здесь не бывает, и держит это ОКРУГЛЕНИЕ ВВЕРХ, а не защитный зажим:
 * отметка попала в окно по строгому `t - x < window`, значит остатка не
 * меньше миллисекунды, и `Math.ceil` делает из него целую секунду. Зажим
 * `Math.max(1, …)` здесь стоял и снят: он не мог сработать ни разу, а
 * объяснял бы поведение, которого не держит
 * (agent_docs/guides/verification.md, «Механизм обязан быть тем, что описан»).
 */
function secondsUntilFree(oldest, window, t) {
  return Math.ceil((oldest + window - t) / 1000)
}

export function createLimiter(env, { now = () => Date.now() } = {}) {
  /** @type {Map<string, number[]>} адрес → отметки запросов, по возрастанию */
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
     * Резервирует один запрос к службе MCP. Вызывать ДО обращения к службе.
     * Отказ несёт `retryAfterSec` — секунды до освобождения слота.
     */
    reserve(ip) {
      const t = now()
      sweep(t)
      const times = hits.get(ip) ?? []

      const minute = times.filter((x) => t - x < MINUTE)
      if (minute.length >= env.RATE_LIMIT_PER_MIN) {
        return {
          ok: false,
          reason: 'minute',
          retryAfterSec: secondsUntilFree(minute[0], MINUTE, t),
          message: 'Предел запросов страницы: слишком часто.',
        }
      }
      if (times.length >= env.RATE_LIMIT_PER_HOUR) {
        return {
          ok: false,
          reason: 'hour',
          retryAfterSec: secondsUntilFree(times[0], HOUR, t),
          message: 'Предел запросов страницы: слишком много запросов за час.',
        }
      }

      hits.set(ip, [...times, t])
      return { ok: true }
    },

    stats() {
      return { trackedIps: hits.size, perMin: env.RATE_LIMIT_PER_MIN, perHour: env.RATE_LIMIT_PER_HOUR }
    },
  }
}
