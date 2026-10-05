// Лимитер дня 24 — копия days/day20/limits.js БЕЗ окна записей: ручки, которая
// правила бы общую базу сервиса, у дня нет (переписки и сессий нет вовсе,
// ADR 2026-10-04-0735, п. 1). Окна два: запуски (`reserve`, минута и час плюс
// суточный потолок) и чтения (`reserveRead`, час — поток событий запуска).
//
// Суточный счётчик общий и не привязан к адресу: он про деньги, а не про
// частоту, и сменой адреса не обходится. Суток у него — UTC.
//
// Проверка и учёт — один синхронный шаг без await между ними (I-4): раздельные
// «проверить» и «посчитать» пропускают залп параллельных запросов мимо окна.
//
// Состояние в памяти процесса. Окно — оно же граница хранения адреса: дольше
// часа IP не живёт (I-10).
//
// Чего этот лимитер НЕ держит, и это надо называть вместе с ним: окно службы
// `rag` — своё, на её стороне, и для неё весь день 24 это ОДИН адрес
// (ADR, п. 4, развилка Р6(а)). 10 запросов в минуту там общие на всех
// посетителей дня, и отсюда их не поднять.

const MINUTE = 60_000
const HOUR = 60 * 60_000

/**
 * Через сколько секунд освободится слот: столько, сколько осталось жить самой
 * ранней отметке в окне. Ноля здесь не бывает, и держит это ОКРУГЛЕНИЕ ВВЕРХ:
 * отметка попала в окно по строгому `t - x < window`, значит остатка не меньше
 * миллисекунды, и `Math.ceil` делает из него целую секунду.
 */
function secondsUntilFree(oldest, window, t) {
  return Math.ceil((oldest + window - t) / 1000)
}

export function createLimiter(env, { now = () => Date.now() } = {}) {
  /** @type {Map<string, number[]>} адрес → отметки запусков, по возрастанию */
  const hits = new Map()
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
    for (const map of [hits, reads]) {
      for (const [ip, times] of map) {
        const kept = times.filter((x) => t - x < HOUR)
        if (kept.length === 0) map.delete(ip)
        else map.set(ip, kept)
      }
    }
  }

  return {
    /**
     * Резервирует один ЗАПУСК. Вызывать ДО обращения к сервису агентов (I-4):
     * запуск зовёт платную модель. Отказ несёт `retryAfterSec` — секунды до
     * освобождения слота; у суточного потолка его нет, и `null` здесь значит
     * «не раньше следующих суток», а не «сейчас».
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
          message: 'Суточный предел вопросов дня исчерпан. Попробуйте завтра.',
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
      // Отметка суток уезжает вместе со слотом: по ней `releaseDaily` узнаёт,
      // те ли это сутки, в которые слот брали.
      return { ok: true, day, released: false }
    },

    /**
     * Возвращает слот СУТОЧНОГО потолка, занятый `reserve`, — и только его.
     *
     * Зачем: порядок «лимитер до сервиса» (I-4) занимает слот ДО разбора тела,
     * поэтому пустой вопрос стоил суточного слота, то есть денег, которых никто
     * не потратил. Решение владельца Р8(б) (ADR 2026-10-05-0544): слот
     * возвращается, а порядок остаётся прежним — резервирование не переезжает в
     * обработчик.
     *
     * ГДЕ ИМЕННО ВОЗВРАЩАЕТСЯ, решает вызывающий, и граница у него узкая: три
     * собственных отказа дня, после которых до сервиса агентов ничего не ушло
     * (`server.js`, `handleRun`). Ответы сервиса — ни 400, ни 502 — слота не
     * возвращают: запрос до него дошёл, и «ничего не ушло» было бы неправдой.
     *
     * ОКНА НА АДРЕС НЕ ТРОГАЮТСЯ, и это не упущение: они про ЧАСТОТУ, а не про
     * деньги. Запрос был сделан, и залп пустых тел обязан упираться в минутное
     * окно ровно так же, как залп настоящих вопросов, — иначе возврат слота
     * сам становится дырой в защите.
     *
     * Два условия, оба обязательны. Слот возвращается ОДИН раз (`released`):
     * двойной вызов из двух ветвей обработчика иначе списал бы чужой слот в
     * минус. И только в ТЕ ЖЕ сутки (`slot.day`): после полуночи счётчик уже
     * обнулён, и вычитание из него вернуло бы слот, которого в этих сутках не
     * занимали.
     */
    releaseDaily(slot) {
      rollDay()
      if (!slot || slot.ok !== true || slot.released === true) return false
      if (slot.day !== day) return false
      slot.released = true
      callsToday = Math.max(0, callsToday - 1)
      return true
    },

    /**
     * Резервирует одно ЧТЕНИЕ (поток событий запуска). Окно своё и отдельное
     * от запусков: исчерпав право читать поток, посетитель не теряет право
     * задать вопрос, и наоборот.
     */
    reserveRead(ip) {
      const t = now()
      rollDay()
      sweep(t)

      const times = reads.get(ip) ?? []
      if (times.length >= env.RATE_LIMIT_READS_PER_HOUR) {
        return {
          ok: false,
          reason: 'reads',
          retryAfterSec: secondsUntilFree(times[0], HOUR, t),
          message: 'Слишком много чтений страницы за час. Попробуйте позже.',
        }
      }
      reads.set(ip, [...times, t])
      return { ok: true }
    },

    stats() {
      rollDay()
      return {
        callsToday,
        dailyLimit: env.MAX_DAILY_CALLS,
        trackedIps: hits.size,
        readIps: reads.size,
        perMin: env.RATE_LIMIT_PER_MIN,
        perHour: env.RATE_LIMIT_PER_HOUR,
      }
    },
  }
}
