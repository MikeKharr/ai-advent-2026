// Проверка аргументов руками: `zod` этой единице недоступен (ADR
// 2026-09-23-1227, п. 2). Правила те же, что у дня 16 (`mcp/src/tools.js`):
// ни один аргумент не является адресом, хостом или путём — хосты зашиты в
// `tools.js`, а адресные символы отвергаются здесь, ДО вызова инструмента.

/** Символы, из которых строят адрес: схема, путь, запрос, якорь, учётные данные. */
export const ADDRESS_LIKE = /[:/\\?#@]/

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

/** Целое в пределах. `undefined` — значение по умолчанию, а не ошибка. */
export function integer(value, { min, max, fallback, what }) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ArgError(`${what}: ожидалось целое число`)
  }
  if (value < min || value > max) throw new ArgError(`${what}: вне пределов ${min}..${max}`)
  return value
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
