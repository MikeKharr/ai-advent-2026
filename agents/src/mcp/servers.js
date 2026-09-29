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
  // Имена ВСЕХ объявленных серверов, включая пропущенные без адреса: список
  // агента сверяется с описанием реестра, а не с тем, что сегодня поднялось.
  // Иначе «сервера нет в реестре» означало бы «переменной окружения нет», и
  // забытая строка в compose валила бы старт вместо предупреждения.
  const known = new Set()
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

    known.add(name)
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

  return { servers, skipped, known }
}

/**
 * Реестр, суженный до списка агента (ADR 2026-09-29-0236, п. 6). Сервер из
 * списка, у которого нет адреса в окружении, здесь просто отсутствует — как и
 * в общем реестре: недоступный сервер остаётся штатным состоянием.
 *
 * Возвращается НОВАЯ карта в порядке списка агента: порядок опроса
 * `listAllTools` — порядок этой карты.
 */
export function pickServers(servers, names) {
  const picked = new Map()
  for (const name of names ?? []) {
    const server = servers.get(name)
    if (server) picked.set(name, server)
  }
  return picked
}

/**
 * Сводит два файла конфигурации на старте: каждое имя в `servers` агента
 * обязано быть объявлено в реестре серверов. Опечатка в имени иначе значила бы
 * «инструментов нет» — молча и только в проде.
 */
export function assertAgentServers(registry, known) {
  for (const entry of registry.values()) {
    for (const name of entry.servers ?? []) {
      if (!known.has(name))
        throw new Error(
          `реестр агентов (${entry.id}): servers: сервера «${name}» нет в реестре серверов MCP`,
        )
    }
  }
}
