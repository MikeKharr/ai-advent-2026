// Проверка аргументов руками: `zod` этой единице недоступен (ADR
// 2026-09-23-1227, п. 2).
//
// ГДЕ ЗДЕСЬ «АРГУМЕНТ НИКОГДА НЕ АДРЕС». У `mcpnews` все аргументы —
// названия, и там это правило выражено запретом символов `: / \ ? # @`
// (`mcpnews/src/args.js:17`). Здесь так нельзя и не нужно:
//
//   - `from` и `to` — единственные аргументы, которые вообще СТРОЯТ запрос.
//     Для них правило не ослаблено, а усилено: `langCode` — белый список
//     `^[a-z]{2}(-[a-z]{2})?$` плюс слово `Autodetect`, и он строго уже
//     запрета адресных символов. Адресом такой аргумент стать не может.
//   - `text` — не часть адреса, а полезная нагрузка. Это свободная речь
//     посетителя, в которой `?`, `:` и `/` законны («Как дела?»), а хост
//     зашит в `tools.js` константой и в `q=` уходит через
//     `encodeURIComponent`. Запрет адресных символов здесь ломал бы
//     законные запросы, не закрывая ничего: повлиять на хост или дописать
//     параметр поставщику текст не может. Держит это утверждение тест
//     «текст с адресными символами не дописывает параметров поставщику».

/** Символы, из которых строят адрес: схема, путь, запрос, якорь, учётные данные. */
export const ADDRESS_LIKE = /[:/\\?#@]/

/**
 * Потолок длины текста — ОДНО число на всю единицу. Второй копии нет
 * нигде: схема инструмента подставляет эту же константу, проверка — тоже.
 * Две копии потолка уже были блокирующей находкой обоих гейтов в
 * `mcpstore`; повторять её незачем.
 *
 * Значение — предел поставщика, установленный прогоном 2026-09-28: сверх
 * 500 ЗНАКОВ (не байтов) MyMemory отвечает `QUERY LENGTH LIMIT EXCEEDED.
 * MAX ALLOWED QUERY : 500 CHARS`. Документация поставщика говорит «500
 * байт» — прогон её опроверг: 300 кириллических знаков (600 байт) прошли.
 */
export const TEXT_LIMIT = 500

/** Слово, которым MyMemory включает автоопределение источника. Проверено прогоном. */
export const AUTODETECT = 'Autodetect'

export class ArgError extends Error {}

/** Строка-название: непустая, с пределом длины и без адресных символов. */
export function plainString(value, { max, what }) {
  if (typeof value !== 'string') throw new ArgError(`${what}: ожидалась строка`)
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new ArgError(`${what}: пустое значение`)
  if (trimmed.length > max) throw new ArgError(`${what}: длиннее ${max} знаков`)
  if (ADDRESS_LIKE.test(trimmed)) {
    throw new ArgError(`${what}: это название, а не адрес — символы : / \\ ? # @ не принимаются`)
  }
  return trimmed
}

/**
 * Код языка: ISO 639-1 из двух букв, при необходимости с областью
 * (`zh-CN`, `pt-BR`). Белый список, а не чёрный: всё, чего в нём нет, —
 * отказ до похода наружу.
 */
export function langCode(value, { what, allowAuto = false }) {
  if (allowAuto && (value === undefined || value === null)) return AUTODETECT
  if (typeof value !== 'string') throw new ArgError(`${what}: ожидалась строка`)
  const trimmed = value.trim()
  if (allowAuto && trimmed.toLowerCase() === AUTODETECT.toLowerCase()) return AUTODETECT
  if (!/^[a-z]{2}(-[a-z]{2})?$/i.test(trimmed)) {
    throw new ArgError(
      `${what}: ожидался код языка из двух букв, например ru или en${allowAuto ? ` (либо ${AUTODETECT})` : ''}`,
    )
  }
  const [base, region] = trimmed.split('-')
  return region ? `${base.toLowerCase()}-${region.toUpperCase()}` : base.toLowerCase()
}

/**
 * Текст на перевод. Отказ, а НЕ обрезка, сверх потолка — решение
 * осознанное: текст здесь несёт намерение посетителя, и обрезанное на
 * полуслове намерение уходит в перевод и в выжимку молча. Отказ называет
 * предел числом, и вызывающий вправе разбить текст сам. (Выжимка в
 * `mcpnews` режется — но там режется ВЫВОД, и о срезе сказано полем
 * `clipped`; обрезать ВВОД тем же правом нельзя.)
 *
 * Управляющие знаки вырезаются: они ничего не значат для перевода, а в
 * журнале и на экране рвут строку.
 */
export function translatable(value, { what }) {
  if (typeof value !== 'string') throw new ArgError(`${what}: ожидалась строка`)
  const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').trim()
  if (cleaned.length === 0) throw new ArgError(`${what}: пустое значение`)
  if (cleaned.length > TEXT_LIMIT) {
    throw new ArgError(`${what}: длиннее ${TEXT_LIMIT} знаков — поставщик столько не принимает, разбейте текст`)
  }
  return cleaned
}

/**
 * Обёртка разбора для `tools/call`: наружу уходит `{ok, value}` либо
 * `{ok: false, error}`, а `rpc.js` превращает второе в `isError`.
 */
export function parser(fn) {
  return (args) => {
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      return { ok: false, error: 'arguments: ожидался объект' }
    }
    try {
      return { ok: true, value: fn(args) }
    } catch (error) {
      if (error instanceof ArgError) return { ok: false, error: error.message }
      throw error
    }
  }
}
