// Лимитер дня 20 — копия days/day16/limits.js плюс ОДНО добавление: суточный
// счётчик вызовов на всё приложение (ADR 2026-09-28-0736, п. 9: MAX_DAILY_CALLS
// 50). У дня 16 его нет потому, что служба MCP денег не стоит; запуск дня 20
// зовёт модель через роутер, и суточный потолок здесь охраняет деньги, а не
// чужие API. Окна на адрес — 5/мин, 30/час — дословно те же.
//
// Счётчик суточный и общий: он не привязан к адресу и переживает смену адреса.
// Суток у него — UTC, как у потолка стартов планировщика.
//
// Проверка и учёт — один синхронный шаг без await между ними (I-4): раздельные
// «проверить» и «посчитать» пропускают залп параллельных запросов мимо окна.
//
// Состояние в памяти процесса. Окно — оно же граница хранения адреса: дольше
// часа IP не живёт (I-10).
//
// Окон здесь три, и они РАЗНЫЕ (ADR 2026-09-29-1600, п. 2): запуски (`reserve`,
// минута и час плюс суточный потолок), записи (`reserveWrite`, час) и чтения
// (`reserveRead`, час). Чтения не сидят в окне записей нарочно: иначе загрузка
// страницы отнимала бы у посетителя право очистить переписку.

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
  /** @type {Map<string, number[]>} адрес → отметки запусков, по возрастанию */
  const hits = new Map()
  /** @type {Map<string, number[]>} адрес → отметки записей, по возрастанию */
  const writes = new Map()
  /** @type {Map<string, number[]>} адрес → отметки чтений, по возрастанию */
  const reads = new Map()
  let callsToday = 0
  let day = new Date(now()).toISOString().slice(0, 10)

  function rollDay() {
    const today = new Date(now()).toISOString().slice(0, 10)
    if (today !== day) {
      day = today
      callsToday = 0
    }
  }

  function sweep(t) {
    for (const map of [hits, writes, reads]) {
      for (const [ip, times] of map) {
        const kept = times.filter((x) => t - x < HOUR)
        if (kept.length === 0) map.delete(ip)
        else map.set(ip, kept)
      }
    }
  }

  /**
   * Часовое окно на адрес поверх карты отметок. Проверка и учёт — один
   * синхронный шаг без await между ними (I-4), как у `reserve`.
   */
  function reserveHourly(map, ip, limit, reason, message) {
    const t = now()
    rollDay()
    sweep(t)

    const times = map.get(ip) ?? []
    if (times.length >= limit) {
      return { ok: false, reason, retryAfterSec: secondsUntilFree(times[0], HOUR, t), message }
    }
    map.set(ip, [...times, t])
    return { ok: true }
  }

  return {
    /**
     * Резервирует один запрос к службе MCP. Вызывать ДО обращения к службе.
     * Отказ несёт `retryAfterSec` — секунды до освобождения слота.
     */
    reserve(ip) {
      const t = now()
      rollDay()
      sweep(t)

      // Суточный потолок проверяется ПЕРВЫМ: он про деньги, окна на адрес —
      // про частоту. Смена адреса его не обходит.
      if (callsToday >= env.MAX_DAILY_CALLS) {
        return {
          ok: false,
          reason: 'daily',
          retryAfterSec: null,
          message: 'Суточный предел запусков дня исчерпан. Попробуйте завтра.',
        }
      }

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

      callsToday += 1
      hits.set(ip, [...times, t])
      return { ok: true }
    },

    /**
     * Резервирует одну ЗАПИСЬ в общую базу сервиса (очистка переписки).
     * Денег не стоит, но правит состояние за всех, поэтому окно своё и
     * отдельное от запусков: исчерпав право писать, посетитель не теряет
     * право запускать, и наоборот.
     */
    reserveWrite(ip) {
      return reserveHourly(
        writes,
        ip,
        env.RATE_LIMIT_WRITES_PER_HOUR,
        'writes',
        'Слишком много изменений переписки за час. Попробуйте позже.',
      )
    },

    /**
     * Резервирует одно ЧТЕНИЕ (переписка, поток событий запуска). Окно своё:
     * страница читает на каждой загрузке и после каждого хода, и под окном
     * записей чтение отнимало бы право писать.
     */
    reserveRead(ip) {
      return reserveHourly(
        reads,
        ip,
        env.RATE_LIMIT_READS_PER_HOUR,
        'reads',
        'Слишком много чтений страницы за час. Попробуйте позже.',
      )
    },

    stats() {
      rollDay()
      return {
        callsToday,
        dailyLimit: env.MAX_DAILY_CALLS,
        trackedIps: hits.size,
        writeIps: writes.size,
        readIps: reads.size,
        perMin: env.RATE_LIMIT_PER_MIN,
        perHour: env.RATE_LIMIT_PER_HOUR,
      }
    },
  }
}
