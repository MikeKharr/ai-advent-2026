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
// Цикл по сети `tools` покрывает `mcpnews` и `mcpstore`. Служба дня 16 живёт в
// сети `mcp` и подключена отдельным решением (ADR 2026-09-29-0236, п. 5) —
// её адрес проверяется своим тестом в конце файла, тем же способом «собрать из
// источников», но порт у неё лежит не в `server.js`, а в `src/env.js`.
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

// Служба дня 16 — третий сервер хоста (ADR 2026-09-29-0236, п. 5). До него
// этот же тест держал ПРОТИВОПОЛОЖНОЕ: `MCP_DAY16_URL` у службы agents быть не
// должно, пока решения нет. Решение принято — проверка развёрнута, а не снята:
// теперь она краснеет, если адрес пропадёт или разъедется с портом и путём
// самой службы. Без неё `loadServers` положил бы day16 в `skipped` молча, и
// день 20 остался бы с двумя серверами при зелёной выкатке.
//
// Ключ MCP_KEY здесь НЕ проверяется и проверяться не может: он секрет, живёт в
// agents.env на сервере и в compose.yml его нет. Его отсутствие — не «скрытый
// отказ»: без ключа служба отвечает хосту 404, и day16 попадает в
// `unreachable` с предупреждением в журнале.
test('сервис агентов знает адрес службы MCP дня 16', () => {
  const entry = registry.find((s) => s.name === 'day16')
  assert.ok(entry, `${REGISTRY}: запись day16 пропала — проверку не о чем вести`)

  // Порт службы задан умолчанием в её разборе окружения, а не в server.js.
  const m = /^ {2}PORT: (\d+),$/m.exec(read('mcp/src/env.js'))
  assert.ok(m, 'mcp/src/env.js: не найден порт по умолчанию — ожидаемый адрес собрать не из чего')
  const port = m[1]
  const expected = `http://mcp:${port}${pathOf('mcp')}`

  assert.ok(
    services.get('mcp').expose.includes(port),
    `${COMPOSE}: служба mcp слушает ${port} (mcp/src/env.js), но expose его не объявляет`,
  )
  assert.equal(
    env.get(entry.urlEnv),
    expected,
    `${COMPOSE}: у службы agents нет ${entry.urlEnv}=${expected}; без него loadServers положит day16 в skipped молча, и день 20 останется с двумя серверами`,
  )
  // Адрес без сети — обещание без пути. Саму сеть держит страж
  // .github/scripts/compose-networks.mjs (правило `joined`); здесь проверяется
  // ровно то, что эти два решения не разъехались.
  assert.ok(
    services.get('agents').networks.includes('mcp'),
    `${COMPOSE}: у службы agents есть ${entry.urlEnv}, но сети mcp нет — имя не разрешится`,
  )
})

// Служба индекса проекта — четвёртый сервер хоста (ADR 2026-10-04-0735, п. 1),
// её зовёт агент дня 22. Собирается тем же способом «из источников», но оба
// источника здесь на Python: порт — умолчание `PORT` в `rag/serve.py`, путь —
// маршрут `Route("POST", ("/rag",), …)` там же. Без адреса `loadServers`
// положил бы `rag` в `skipped` МОЛЧА, и день 22 говорил бы «поиск
// недоступен» при живом контейнере и зелёной выкатке.
//
// Ключ RAG_KEY здесь не проверяется и проверяться не может: он секрет, живёт
// в agents.env на сервере и в compose.yml его нет. Его отсутствие — не
// скрытый отказ: без ключа служба отвечает хосту как на несуществующий путь,
// поиск отказывает, и модель при этом не вызывается.
test('сервис агентов знает адрес службы индекса проекта', () => {
  const entry = registry.find((s) => s.name === 'rag')
  assert.ok(entry, `${REGISTRY}: запись rag пропала — проверку не о чем вести`)

  const serve = read('rag/serve.py')
  const port = /^PORT = int\(os\.environ\.get\("PORT", "(\d+)"\)\)$/m.exec(serve)
  assert.ok(port, 'rag/serve.py: не найден порт по умолчанию — ожидаемый адрес собрать не из чего')
  const route = /Route\("POST", \("([^"]+)",\), "call"/.exec(serve)
  assert.ok(route, 'rag/serve.py: не найден маршрут вызова — ожидаемый адрес собрать не из чего')
  const expected = `http://rag:${port[1]}${route[1]}`

  assert.ok(
    services.get('rag').expose.includes(port[1]),
    `${COMPOSE}: служба rag слушает ${port[1]} (rag/serve.py), но expose его не объявляет`,
  )
  assert.equal(
    env.get(entry.urlEnv),
    expected,
    `${COMPOSE}: у службы agents нет ${entry.urlEnv}=${expected}; без него loadServers положит rag в skipped молча, и день 22 скажет «поиск недоступен» при зелёной выкатке`,
  )
  // Адрес без сети — обещание без пути. Саму сеть держит страж
  // .github/scripts/compose-networks.mjs (правило `joined`); здесь проверяется
  // ровно то, что эти два решения не разъехались.
  assert.ok(
    services.get('agents').networks.includes('rag'),
    `${COMPOSE}: у службы agents есть ${entry.urlEnv}, но сети rag нет — имя не разрешится`,
  )
})
