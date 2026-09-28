// Таблица соответствия имён инструментов (ADR 2026-09-28-0736, п. 1).
//
// У сервера MCP инструмент зовётся `news.search`. Роутер требует от имени
// `^[a-zA-Z0-9_-]{1,128}$` — точка не проходит, и у двух серверов имена могут
// совпасть. Поэтому модели инструмент показывается как `<сервер>__<имя с
// точками через подчёркивание>`, а обратно разбирается по индексу, а не по
// разбору строки: имя сервера с двумя подчёркиваниями подряд сломало бы
// разбор молча, а индекс на такое имя просто не найдёт записи.
//
// Таблица — часть трейса: на экране видно, каким именем инструмент назван
// модели и каким его знает сервер.

/** Допустимое имя инструмента для роутера. */
export const API_TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/

/** Имя инструмента для модели. Непроходное имя — ошибка здесь, а не 400 роутера. */
export function apiToolName(server, tool) {
  const name = `${server}__${tool.replace(/\./g, '_')}`
  if (!API_TOOL_NAME.test(name))
    throw new Error(`инструмент ${server}/${tool}: имя ${name} не проходит ограничение роутера`)
  return name
}

/**
 * Индекс инструментов: имя для модели → `{server, tool}` и обратно. Строится
 * из списка `listAllTools`, где у каждого инструмента уже стоит имя сервера.
 */
export function buildToolIndex(tools) {
  const byApiName = new Map()
  for (const tool of tools) {
    const apiName = apiToolName(tool.server, tool.name)
    if (byApiName.has(apiName))
      throw new Error(`инструмент ${apiName}: имя повторяется у ${tool.server}`)
    byApiName.set(apiName, { server: tool.server, tool: tool.name, schema: tool.inputSchema ?? {} })
  }
  return {
    /** Пары «имя у модели → имя на сервере» для трейса и экрана. */
    table: () => [...byApiName].map(([apiName, at]) => ({ apiName, server: at.server, tool: at.tool })),
    /** Куда идти по имени, которым инструмент назвала модель. Чужое имя — `null`. */
    resolve: (apiName) => byApiName.get(apiName) ?? null,
    size: () => byApiName.size,
  }
}
