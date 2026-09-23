// Изоляция службы MCP в отдельной сети compose — ADR 2026-09-23-1227, п. 5,
// условие вето compliance. Правило: контейнер `mcp` живёт ТОЛЬКО в сети `mcp`,
// а в сети `mcp` — только `caddy`, сам `mcp` и день 16. В сети по умолчанию,
// где `router`, `agents` и всё, что читает `secrets.env`, его нет: оттуда не
// разрешается даже имя.
//
// Проверяется структура файла, а не намерение в комментарии. Служба без
// ключа `networks:` попадает в сеть по умолчанию — это и есть случай, ради
// которого страж написан: достаточно забыть две строки, и защита исчезает
// молча, а compose останется рабочим.
//
// Запуск из корня репозитория: node .github/scripts/compose-networks.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const COMPOSE = 'deploy/compose.yml'

/** Служба, которую изолируем, и её сеть. */
export const ISOLATED = 'mcp'
/** Кто ещё вправе быть в сети `mcp`: вход и день, ради которого она заведена. */
export const ALLOWED_IN_NETWORK = ['caddy', 'mcp', 'day16']
/**
 * Жильцы сети: им положена РОВНО ОДНА сеть — своя. `caddy` в этот список не
 * входит намеренно: он вход, обе сети ему положены по работе. Без этого
 * различения список выше разрешал бы дню 16 быть в `mcp` и в сети по
 * умолчанию одновременно — мостик из изолированной сети туда, где `router`,
 * `agents` и `secrets.env` (находка `compliance` к PR дня 16).
 */
export const ONLY_IN_NETWORK = ['mcp', 'day16']

const COMMENT = /^\s*#/

/**
 * Разбор ровно того, что нужно: имена служб и список сетей каждой.
 * Не YAML-парсер — подмножество, на котором написан deploy/compose.yml:
 * службы на отступе 2, их ключи на 4, сети под `networks:` на 6 — списком
 * (`- edge`) или отображением (`edge:`). Неизвестная форма — исключение, а не
 * тихий пропуск: страж, который не понял файл, обязан покраснеть.
 */
export function parseServices(text) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l === 'services:')
  if (start === -1) throw new Error(`${COMPOSE}: не найден блок services:`)

  const services = new Map()
  let service = null
  let inNetworks = false

  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || COMMENT.test(line)) continue
    const indent = line.search(/\S/)
    if (indent === 0) break // конец блока services (volumes:, networks: верхнего уровня)

    if (indent === 2) {
      const name = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line)
      if (!name) throw new Error(`${COMPOSE}: непонятная строка службы: ${line}`)
      service = name[1]
      services.set(service, null) // null — ключа networks нет, то есть сеть по умолчанию
      inNetworks = false
      continue
    }
    if (indent === 4) {
      inNetworks = /^ {4}networks:\s*$/.test(line)
      if (inNetworks) services.set(service, [])
      continue
    }
    if (!inNetworks || indent < 6) continue

    // Внутри networks: интересуют только имена сетей — строки отступа 6.
    // Глубже (aliases и прочее) — не наше дело.
    if (indent > 6) continue
    const item = /^ {6}(?:- )?([A-Za-z0-9_.-]+):?\s*$/.exec(line)
    if (!item) throw new Error(`${COMPOSE}: непонятная строка сети у службы ${service}: ${line}`)
    services.get(service).push(item[1])
  }
  if (services.size === 0) throw new Error(`${COMPOSE}: в блоке services не найдено ни одной службы`)
  return services
}

/** Нарушения изоляции — списком строк. Пусто — изоляция на месте. */
export function problems(text) {
  const services = parseServices(text)
  const found = []

  if (!services.has(ISOLATED)) {
    found.push(`службы ${ISOLATED} нет в ${COMPOSE}`)
    return found
  }

  for (const name of ONLY_IN_NETWORK) {
    // Уехавшая служба — не дыра: дыра была бы, останься она с двумя сетями.
    if (!services.has(name)) continue
    const networks = services.get(name)
    if (networks === null) {
      found.push(`у службы ${name} нет ключа networks: — она в сети по умолчанию, вместе с router, agents и secrets.env`)
    } else if (networks.length !== 1 || networks[0] !== ISOLATED) {
      found.push(`служба ${name} должна быть только в сети ${ISOLATED}, а объявлена в: ${networks.join(', ') || '(пусто)'}`)
    }
  }

  for (const [name, networks] of services) {
    if (networks === null || !networks.includes(ISOLATED)) continue
    if (!ALLOWED_IN_NETWORK.includes(name)) {
      found.push(`служба ${name} в сети ${ISOLATED}: там разрешены только ${ALLOWED_IN_NETWORK.join(', ')}`)
    }
  }
  return found
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const found = problems(readFileSync(join(process.cwd(), COMPOSE), 'utf8'))
  for (const problem of found) console.log(`::error file=${COMPOSE}::${problem}`)
  if (found.length) {
    console.log(`::error::изоляция сети ${ISOLATED} нарушена — ADR 2026-09-23-1227, п. 5`)
    process.exit(1)
  }
  console.log(`ok: ${ONLY_IN_NETWORK.join(' и ')} — каждая только в сети ${ISOLATED}; в сети ${ISOLATED} — только ${ALLOWED_IN_NETWORK.join(', ')}`)
}
