// Ключ поверхности управления (ADR 2026-09-28-1820, п. 2, свойства ▲).
//
// Ключ — ЕДИНСТВЕННАЯ преграда: сеть владелец решил не закрывать, зная цену
// («Что снято решением владельца»). Поэтому здесь собрано всё, что от ключа
// зависит, и ничего сверх.
//
// Что держит этот модуль:
//   — ключ предъявляется ТОЛЬКО как `Authorization: Bearer <ключ>`. Ключ в
//     строке адреса (`?key=`) и в своём заголовке (`X-Control-Key`) —
//     401, и предъявленное значение никуда не записывается;
//   — сравнение постоянного времени через `timingSafeEqual`: соседи по сети
//     `default` больше не доверенные;
//   — 401 несёт `WWW-Authenticate: Bearer realm="control"` — форма
//     обнаружения по спецификации, без метаданных OAuth;
//   — окно неудачных попыток на адрес соединения: проверяется ДО сравнения
//     ключа, чтобы залп не оплачивался сравнением.
//
// Чего он НЕ держит и не может: время сравнения тестом не измеряется. Тест
// держит ПРИСУТСТВИЕ пути сравнения через `timingSafeEqual` — строку, а не
// свойство. Это честная граница, а не измерение.
//
// Предъявленное значение ключа не принимает ни одна функция журнала: его
// некуда передать. Это структурный запрет, а не договорённость.

import { timingSafeEqual } from 'node:crypto'

/** Область для `WWW-Authenticate`: по ней клиент MCP узнаёт, чей это 401. */
export const CONTROL_REALM = 'control'

/** Заголовок, которым ключ НЕ предъявляется. Назван, чтобы был тест. */
export const FORBIDDEN_KEY_HEADER = 'x-control-key'

/** Параметр строки адреса, которым ключ НЕ предъявляется. */
export const FORBIDDEN_KEY_PARAM = 'key'

/** Значение `Authorization` или `null`, если это не `Bearer`. */
export function bearer(req) {
  const header = req.headers?.authorization ?? ''
  return header.startsWith('Bearer ') ? header.slice(7) : null
}

/** Сравнение постоянного времени. Разная длина — сразу нет, длина не секрет. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

const MINUTE = 60_000

/**
 * Проверка входа поверхности.
 *
 * `key === null` — поверхность выключена (ключ не задан, короче предела или
 * совпал с чужим, см. `env.js`). Тогда ответ на всё — 503 `control_disabled`,
 * а не 401: «выключен» обязан быть отличим от «чужой ключ», иначе оператор
 * будет чинить ключ клиента вместо строки в `agents.env`.
 */
export function createControlKey({ key, failsPerMin, now = Date.now }) {
  /** Адрес → { until, fails }. Окно в памяти: оно про шум, а не про деньги. */
  const windows = new Map()

  const sweep = (at) => {
    for (const [remote, w] of windows) if (w.until <= at) windows.delete(remote)
  }

  return {
    enabled: key !== null,

    /** Сколько адресов сейчас в окне — для `/healthz`. Значений ключа тут нет. */
    watching: () => windows.size,

    /**
     * Порядок проверок сверху вниз и есть порядок исполнения (I-4):
     * выключено → окно отказов → форма предъявления → сравнение.
     */
    check({ req, url, remote, at = now() }) {
      if (key === null) {
        return { ok: false, status: 503, code: 'control_disabled', outcome: 'disabled' }
      }

      // Окно — ДО сравнения ключа: залп не должен оплачиваться сравнением,
      // и адрес, уже набравший отказов, не получает новых попыток.
      const open = windows.get(remote)
      if (open && open.until > at && open.fails >= failsPerMin) {
        return {
          ok: false,
          status: 429,
          code: 'too_many_attempts',
          outcome: 'rate_limited',
          headers: { 'retry-after': String(Math.ceil((open.until - at) / 1000)) },
        }
      }

      // Ключ в строке адреса или в своём заголовке — отказ, и именно отказ,
      // а не «примем, раз уж прислали»: строка адреса попадает в журналы
      // прокси целиком, а свой заголовок увёл бы поверхность со спецификации.
      const offSpec =
        url?.searchParams?.has(FORBIDDEN_KEY_PARAM) === true ||
        req.headers?.[FORBIDDEN_KEY_HEADER] !== undefined

      // Предъявленное значение дальше этой строки не уходит НИКУДА: его не
      // принимает ни журнал, ни ответ.
      if (offSpec || !safeEqual(bearer(req), key)) return fail(at, remote, offSpec)
      return { ok: true }
    },
  }

  function fail(at, remote, offSpec) {
    const w = windows.get(remote)
    if (!w || w.until <= at) windows.set(remote, { until: at + MINUTE, fails: 1 })
    else w.fails += 1
    sweep(at)
    return {
      ok: false,
      status: 401,
      code: 'unauthorized',
      outcome: 'unauthorized',
      // Что именно не так с предъявлением — не говорится: подсказка
      // сужала бы перебор, а обнаружение по спецификации даёт заголовок.
      offSpec,
      headers: { 'www-authenticate': `Bearer realm="${CONTROL_REALM}"` },
    }
  }
}
