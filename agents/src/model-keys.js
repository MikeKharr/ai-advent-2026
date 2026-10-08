// Именные ключи модели без встроенных отказов (ADR 2026-10-07-1349, п. 2).
//
// Ключ ограничивает И запуск, И чтение ключевого профиля (решение владельца
// 10). Имя ключа — метка для журнала, суточного потолка и столбца
// `profiles.key_name`; оно НЕ секрет. Секрет — значение.
//
// Что держит этот модуль:
//   — пустая или отсутствующая `MODEL_KEYS` означает «возможности нет вовсе»:
//     `enabled === false`, и ЛЮБОЙ предъявленный заголовок — отказ. Пустой
//     заголовок при пустой переменной не совпадает: сравнение пустых строк
//     открыло бы ключевые профили всем;
//   — сверка идёт по ВСЕМ записям без короткого замыкания: цикл не
//     прерывается на совпадении, поэтому число сравнений не зависит от того,
//     какое имя подошло и подошло ли вообще;
//   — сравнение постоянного времени через `timingSafeEqual`;
//   — окно неудачных попыток на адрес соединения — ДО сравнения: 403 без
//     окна есть бесплатный оракул на перебор значений;
//   — суточный потолок на ИМЯ (решение владельца 8), в памяти процесса;
//   — предъявленное значение не принимает ни одна функция журнала: его
//     некуда передать. Это структурный запрет, а не договорённость — в
//     результатах ниже есть только имя, и то лишь при совпадении.
//
// Чего он НЕ держит и не может: время сравнения тестом не измеряется. Тест
// держит ПРИСУТСТВИЕ пути сравнения через `timingSafeEqual` — строку, а не
// свойство, ровно как у `control/key.js`. Это честная граница, а не
// измерение. Та же честная граница записана в `agent_docs/backlog/` по
// `mcp/src/service.js`.

import { timingSafeEqual } from 'node:crypto'

/** Заголовок, которым предъявляется ключ. Один и только один. */
export const MODEL_KEY_HEADER = 'x-model-key'

/**
 * Имя ключа: метка профиля и счётчика. Закрытый набор знаков — имя уходит в
 * журнал и в столбец базы, и запятая или двоеточие в нём разъехались бы с
 * разбором `MODEL_KEYS`.
 */
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/

/**
 * Значение ключа: 24 случайных байта в base64url (32 знака). Предел снизу —
 * не «надёжность», а защита от обрезанной при переносе строки: короткое
 * значение означает промах копирования, а не слабый ключ.
 */
const VALUE_MIN_CHARS = 24

const MINUTE = 60_000
const DAY = 24 * 3600_000

/**
 * Разбор `MODEL_KEYS`: `имя:значение` через запятую. Негодная запись
 * ОТБРАСЫВАЕТСЯ с замечанием, а не роняет сервис: в этом процессе живут дни
 * 6–25, и опечатка в ключе одного человека не должна уносить их с собой —
 * тот же довод, что у `CONTROL_KEY` и ключа планировщика (`env.js`).
 *
 * Значения в замечания не попадают: замечания идут в журнал процесса.
 */
export function parseModelKeys(raw) {
  const notes = []
  const entries = []
  const seen = new Set()
  for (const piece of String(raw ?? '').split(',')) {
    const row = piece.trim()
    if (row === '') continue
    const at = row.indexOf(':')
    if (at === -1) {
      notes.push({ event: 'model_key_malformed', message: 'запись MODEL_KEYS без двоеточия отброшена' })
      continue
    }
    const name = row.slice(0, at).trim()
    const value = row.slice(at + 1).trim()
    if (!NAME.test(name)) {
      notes.push({
        event: 'model_key_bad_name',
        message: 'имя ключа MODEL_KEYS вне [a-z0-9_-] (до 32 знаков) — запись отброшена',
      })
      continue
    }
    if (value.length < VALUE_MIN_CHARS) {
      notes.push({
        event: 'model_key_too_short',
        message: `значение ключа ${name} короче ${VALUE_MIN_CHARS} знаков: строка обрезана при переносе — запись отброшена`,
      })
      continue
    }
    if (seen.has(name)) {
      notes.push({
        event: 'model_key_duplicate_name',
        message: `имя ключа ${name} повторяется — вторая запись отброшена`,
      })
      continue
    }
    seen.add(name)
    entries.push({ name, value })
  }
  return { entries, notes }
}

/**
 * Сверка ключа и потолок имени.
 *
 * `entries` пуст — возможности нет вовсе: `enabled === false`, `check` на
 * любой заголовок отвечает отказом, и ключевые профили не создаются и
 * недостижимы (как несуществующие).
 *
 * @param dailyCap сколько запусков в сутки на одно имя (решение владельца 8).
 */
export function createModelKeys({ entries = [], failsPerMin = 10, dailyCap = 2000, now = Date.now } = {}) {
  /** Адрес → { until, fails }. Окно в памяти: оно про шум, а не про деньги. */
  const windows = new Map()
  /** Имя → { day, calls }. Потолок в памяти: перезапуск его сбрасывает. */
  const counters = new Map()

  const sweep = (at) => {
    for (const [remote, w] of windows) if (w.until <= at) windows.delete(remote)
  }

  const fail = (at, remote) => {
    const w = windows.get(remote)
    if (!w || w.until <= at) windows.set(remote, { until: at + MINUTE, fails: 1 })
    else w.fails += 1
    sweep(at)
    // Отказ не называет имени и не несёт предъявленного значения: подсказка
    // сузила бы перебор, а значению здесь попросту нет поля.
    return {
      ok: false,
      status: 403,
      code: 'bad_model_key',
      message: 'Ключ модели не принят',
    }
  }

  return {
    enabled: entries.length > 0,

    /** Сколько имён настроено — для `/healthz`. Ни имён, ни значений тут нет. */
    size: () => entries.length,

    /** Сколько адресов сейчас в окне — для `/healthz`. */
    watching: () => windows.size,

    /**
     * Предъявлен ли заголовок вообще. Отдельно от сверки: «заголовка нет» —
     * это обычный открытый профиль дня 11, а «заголовок есть и не подошёл» —
     * 403. Смешав эти два случая, опечатка в ключе родила бы открытый
     * профиль (Б8).
     */
    presented(req) {
      const value = req.headers?.[MODEL_KEY_HEADER]
      return typeof value === 'string'
    },

    /**
     * Порядок проверок сверху вниз и есть порядок исполнения (I-4):
     * заголовка нет → имени нет; выключено → отказ; окно отказов → отказ;
     * сверка по всем записям → имя.
     *
     * @returns `{ ok: true, name: null }` — заголовка не было, путь открытого
     *   профиля; `{ ok: true, name }` — ключ этого имени; иначе отказ со
     *   статусом и кодом.
     */
    check({ req, remote, at = now() }) {
      const presented = req.headers?.[MODEL_KEY_HEADER]
      if (typeof presented !== 'string') return { ok: true, name: null }

      // Выключенная возможность отказывает ДО окна и до сверки: сравнивать
      // не с чем. Пустой заголовок при пустой переменной тоже отказ — иначе
      // ключевые профили были бы открыты всем (и их бы не было вовсе).
      if (entries.length === 0) {
        return {
          ok: false,
          status: 403,
          code: 'bad_model_key',
          message: 'Ключ модели не принят',
        }
      }

      // Окно — ДО сверки: залп не должен оплачиваться сравнением, и адрес,
      // уже набравший отказов, не получает новых попыток.
      const open = windows.get(remote)
      if (open && open.until > at && open.fails >= failsPerMin) {
        return {
          ok: false,
          status: 429,
          code: 'too_many_attempts',
          message: 'Слишком много попыток — подождите минуту',
          headers: { 'retry-after': String(Math.ceil((open.until - at) / 1000)) },
        }
      }

      // Сверка по ВСЕМ записям без короткого замыкания: `break` на
      // совпадении сделал бы число сравнений зависимым от позиции имени в
      // списке. Предъявленное значение дальше этих строк не уходит никуда.
      let matched = null
      for (const entry of entries) {
        if (safeEqual(presented, entry.value)) matched = entry.name
      }
      if (matched === null) return fail(at, remote)
      return { ok: true, name: matched }
    },

    /**
     * Занять суточный слот имени (решение владельца 8). Зовётся ПОСЛЕ сверки
     * ключа и ДО роутера: ключ меняет, КОМУ доступна модель, а не что стоит
     * раньше (I-4). Та же честная граница, что у I-5: счётчик в памяти, и
     * перезапуск его сбрасывает.
     */
    charge(name, at = now()) {
      const today = new Date(at).toISOString().slice(0, 10)
      const row = counters.get(name)
      const counter = row && row.day === today ? row : { day: today, calls: 0 }
      counters.set(name, counter)
      if (counter.calls >= dailyCap) {
        return {
          ok: false,
          status: 429,
          code: 'model_key_daily_cap',
          message: `Суточный потолок ${dailyCap} запусков на ключ исчерпан`,
          resetAt: new Date(Date.UTC(...nextDay(today))).toISOString(),
        }
      }
      counter.calls += 1
      return { ok: true, used: counter.calls, cap: dailyCap }
    },

    /** Сколько занято сегодня — для теста потолка и для `/healthz` по имени. */
    used(name, at = now()) {
      const row = counters.get(name)
      return row && row.day === new Date(at).toISOString().slice(0, 10) ? row.calls : 0
    },
  }
}

/** Следующие сутки UTC от `YYYY-MM-DD` — дата сброса потолка. */
function nextDay(today) {
  const [y, m, d] = today.split('-').map(Number)
  return [y, m - 1, d + 1]
}

/** Сравнение постоянного времени. Разная длина — сразу нет, длина не секрет. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}
