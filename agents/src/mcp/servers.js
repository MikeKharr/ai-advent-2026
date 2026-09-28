// Реестр серверов MCP хоста (ADR 2026-09-28-0736, п. 1 и 7). Состав —
// данные в `agents/config/mcp-servers.json`, адреса и ключи — только из
// окружения: адрес в файле означал бы адрес в git, а ключ — секрет в git.
//
// Имя сервера хранится рядом с каждым инструментом и едет в каждую запись
// трейса: на экране видно имя сервера каждого вызова (требование владельца).

import { createMcpClient } from './client.js'

const NAME = /^[a-z][a-z0-9-]{1,30}$/

function fail(name, message) {
  throw new Error(`реестр серверов MCP${name ? ` (${name})` : ''}: ${message}`)
}

/**
 * Проверяет описание реестра и разрешает адреса из окружения. Сервер, у
 * которого переменной адреса нет, в реестр не попадает: недоступный сервер —
 * штатное состояние (ADR, п. 1), а не отказ старта.
 */
export function loadServers(raw, source = process.env, { make = createMcpClient } = {}) {
  if (!raw || !Array.isArray(raw.servers) || raw.servers.length === 0)
    fail(null, 'ожидался непустой список servers')

  const servers = new Map()
  const skipped = []
  for (const entry of raw.servers) {
    const name = entry?.name
    if (typeof name !== 'string' || !NAME.test(name)) fail(name, 'name: латиница, цифры и дефис')
    if (servers.has(name)) fail(name, 'имя повторяется')
    if (typeof entry.urlEnv !== 'string' || entry.urlEnv.trim() === '')
      fail(name, 'urlEnv: ожидалась непустая строка')
    if (entry.keyEnv !== undefined && (typeof entry.keyEnv !== 'string' || entry.keyEnv.trim() === ''))
      fail(name, 'keyEnv: ожидалась непустая строка или отсутствие')
    if (typeof entry.title !== 'string' || entry.title.trim() === '')
      fail(name, 'title: ожидалась непустая строка')

    const url = source[entry.urlEnv] ?? ''
    if (!url) {
      skipped.push({ name, reason: `${entry.urlEnv} не задан` })
      continue
    }
    servers.set(name, {
      name,
      title: entry.title,
      url,
      client: make({ name, url, key: entry.keyEnv ? (source[entry.keyEnv] ?? null) : null }),
    })
  }

  return { servers, skipped }
}
