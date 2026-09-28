// Сервис агентов обязан знать адрес каждого сервера MCP, поднятого в этом же
// compose. Из какого отказа: `loadServers` (agents/src/mcp/servers.js) при
// пустой переменной адреса кладёт сервер в `skipped` и идёт дальше — МОЛЧА.
// Контейнеры при этом живы, выкатка зелёная, а цепочка дня 19 и работа
// планировщика отвечают «инструментов нет». Ни теста, ни красной выкатки у
// этого не было (находка ревьюера PR #235).
//
// Проверяется не «строка есть», а что она означает. Ожидаемый адрес
// собирается из трёх источников, ни один из которых не переписывается вместе
// со строкой в compose.yml:
//   - имя хоста — имя службы в `deploy/compose.yml`, стоящей в сети `tools`;
//   - порт — значение по умолчанию в `<имя>/server.js` (`PORT`), и оно же
//     обязано быть в `expose:` службы;
//   - путь — `MCP_PATH` в `<имя>/src/service.js`.
// Поэтому опечатка в порте или переезд пути краснеют здесь, а не в проде.
//
// Сеть `tools`, а не «все службы»: день 16 тоже сервер MCP, но живёт в сети
// `mcp`, требует алиаса входа и ключа — его адрес отдельное решение, и
// требовать его здесь было бы неверно.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const COMPOSE = 'deploy/compose.yml'
const REGISTRY = 'agents/config/mcp-servers.json'
const NETWORK = 'tools'

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

/**
 * Разбор подмножества compose.yml: для каждой службы — списки под ключами
 * `networks:`, `environment:` и `expose:`. Не YAML-парсер: службы на отступе
 * 2, их ключи на 4, пункты списков на 6. Непонятый пункт — исключение, а не
 * тихий пропуск: страж, не понявший файл, обязан покраснеть.
 */
export function parseServices(text) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l === 'services:')
  if (start === -1) throw new Error(`${COMPOSE}: не найден блок services:`)

  const services = new Map()
  let service = null
  let key = null

  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue
    const indent = line.search(/\S/)
    if (indent === 0) break

    if (indent === 2) {
      const name = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line)
      if (!name) throw new Error(`${COMPOSE}: непонятная строка службы: ${line}`)
      service = name[1]
      services.set(service, { networks: [], environment: [], expose: [] })
      key = null
      continue
    }
    if (indent === 4) {
      const m = /^ {4}([A-Za-z0-9_.-]+):/.exec(line)
      key = m && ['networks', 'environment', 'expose'].includes(m[1]) ? m[1] : null
      continue
    }
    if (key === null || indent !== 6) continue

    if (key === 'networks') {
      const item = /^ {6}(?:- )?([A-Za-z0-9_.-]+):?\s*$/.exec(line)
      if (!item) throw new Error(`${COMPOSE}: непонятная строка сети у службы ${service}: ${line}`)
      services.get(service).networks.push(item[1])
    } else {
      const item = /^ {6}- (.+?)\s*$/.exec(line)
      if (!item) throw new Error(`${COMPOSE}: непонятный пункт ${key} у службы ${service}: ${line}`)
      services.get(service)[key].push(item[1].replace(/^"(.*)"$/, '$1'))
    }
  }
  if (services.size === 0) throw new Error(`${COMPOSE}: в блоке services не найдено ни одной службы`)
  return services
}

const services = parseServices(read(COMPOSE))
const registry = JSON.parse(read(REGISTRY)).servers
const env = new Map(
  (services.get('agents')?.environment ?? []).map((line) => {
    const at = line.indexOf('=')
    return [line.slice(0, at), line.slice(at + 1)]
  }),
)

/** Порт по умолчанию из точки входа единицы: `... || 8084`. */
function portOf(unit) {
  const m = /process\.env\.PORT\)?\s*\|\|\s*(\d+)/.exec(read(`${unit}/server.js`))
  assert.ok(m, `${unit}/server.js: не найден порт по умолчанию — ожидаемый адрес собрать не из чего`)
  return m[1]
}

/** Путь ручки MCP из службы единицы: `export const MCP_PATH = '/mcp'`. */
function pathOf(unit) {
  const m = /export const MCP_PATH = '([^']+)'/.exec(read(`${unit}/src/service.js`))
  assert.ok(m, `${unit}/src/service.js: не найден MCP_PATH — ожидаемый адрес собрать не из чего`)
  return m[1]
}

/** Серверы MCP этого проекта — службы сети tools, кроме самого сервиса агентов. */
const hosted = [...services]
  .filter(([name, s]) => name !== 'agents' && s.networks.includes(NETWORK))
  .map(([name]) => name)

test('серверы MCP проекта подняты и найдены в compose', () => {
  // Пустая выборка — не успех: проверка, не нашедшая ни одного сервера,
  // зеленела бы и после переименования сети, и после их удаления.
  assert.notEqual(hosted.length, 0, `${COMPOSE}: в сети ${NETWORK} нет ни одной службы, кроме agents`)
})

for (const unit of hosted) {
  test(`сервис агентов знает адрес сервера ${unit}`, () => {
    const entry = registry.find((s) => s.name === unit)
    assert.ok(entry, `${REGISTRY}: сервер ${unit} поднят в ${COMPOSE}, но хост о нём не знает`)

    const port = portOf(unit)
    const expected = `http://${unit}:${port}${pathOf(unit)}`
    assert.ok(
      services.get(unit).expose.includes(port),
      `${COMPOSE}: служба ${unit} слушает ${port} (${unit}/server.js), но expose его не объявляет`,
    )
    assert.equal(
      env.get(entry.urlEnv),
      expected,
      `${COMPOSE}: у службы agents нет ${entry.urlEnv}=${expected}; без него loadServers положит ${unit} в skipped молча, и работа вернёт «инструментов нет»`,
    )
  })
}

// Адрес службы дня 16 тянет за собой сеть mcp, алиас входа и копию MCP_KEY —
// отдельное решение, и в этом файле его быть не должно. Без этой проверки
// строка приехала бы сюда попутно и незаметно.
test('адрес службы дня 16 в compose не заводится попутно', () => {
  const day16 = registry.find((s) => s.name === 'day16')
  assert.ok(day16, `${REGISTRY}: запись day16 пропала — проверку не о чем вести`)
  assert.equal(
    env.has(day16.urlEnv),
    false,
    `${COMPOSE}: ${day16.urlEnv} у службы agents — это сеть mcp и секрет MCP_KEY, отдельное решение`,
  )
})
