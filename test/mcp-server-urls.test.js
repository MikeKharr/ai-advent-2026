// Сервис агентов обязан знать адрес каждого сервера MCP, поднятого в этом же
// compose. Из какого отказа: `loadServers` (agents/src/mcp/servers.js) при
// пустой переменной адреса кладёт сервер в `skipped` и идёт дальше — МОЛЧА.
// Контейнеры при этом живы, выкатка зелёная, а потребитель отвечает
// «инструментов нет». Ни теста, ни красной выкатки у этого не было (находка
// ревьюера PR #235).
//
// Проверяется не «строка есть», а что она означает. Ожидаемый адрес
// собирается из источников, ни один из которых не переписывается вместе со
// строкой в compose.yml: имя хоста — имя службы, порт — её умолчание в коде
// (и оно же обязано быть в `expose:`), путь — маршрут её же службы. Поэтому
// опечатка в порте или переезд пути краснеют здесь, а не в проде.
//
// Серверов осталось два: служба MCP (сеть `mcp`, ADR 2026-09-29-0236, п. 5) и
// индекс проекта (сеть `rag`, ADR 2026-10-04-0735, п. 1) — у каждого свой
// тест ниже. Цикла по сети `tools` здесь больше нет: серверы `mcpnews` и
// `mcpstore` удалены вместе с днями 18–20 (ADR 2026-10-20-0737). Вместе с
// ними снялась и проверка «каждый сервер в этой сети известен хосту» — в
// сети `mcp` и `rag` у служб свои тесты, а третьей сети серверов нет.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const COMPOSE = 'deploy/compose.yml'
const REGISTRY = 'agents/config/mcp-servers.json'

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

/** Путь ручки MCP из службы единицы: `export const MCP_PATH = '/mcp'`. */
function pathOf(unit) {
  const m = /export const MCP_PATH = '([^']+)'/.exec(read(`${unit}/src/service.js`))
  assert.ok(m, `${unit}/src/service.js: не найден MCP_PATH — ожидаемый адрес собрать не из чего`)
  return m[1]
}

// Реестр не пуст: проверка, не нашедшая ни одной записи, зеленела бы и после
// удаления обоих серверов.
test('в реестре серверов MCP есть записи', () => {
  assert.notEqual(registry.length, 0, `${REGISTRY}: реестр серверов пуст`)
})

// Служба MCP — сервер хоста под именем реестра `day16` (ADR 2026-09-29-0236,
// п. 5; имя записи историческое — консоль дня 16 удалена, сама служба
// осталась). До этого решения тест держал ПРОТИВОПОЛОЖНОЕ: `MCP_DAY16_URL` у
// службы agents быть не должно, пока решения нет. Решение принято — проверка
// развёрнута, а не снята: теперь она краснеет, если адрес пропадёт или
// разъедется с портом и путём самой службы. Без неё `loadServers` положил бы
// запись в `skipped` молча, и хост остался бы без её инструментов при зелёной
// выкатке.
//
// Ключ MCP_KEY здесь НЕ проверяется и проверяться не может: он секрет, живёт в
// agents.env на сервере и в compose.yml его нет. Его отсутствие — не «скрытый
// отказ»: без ключа служба отвечает хосту 404, и day16 попадает в
// `unreachable` с предупреждением в журнале.
test('сервис агентов знает адрес службы MCP', () => {
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
    `${COMPOSE}: у службы agents нет ${entry.urlEnv}=${expected}; без него loadServers положит day16 в skipped молча, и хост останется без инструментов службы MCP`,
  )
  // Адрес без сети — обещание без пути. Саму сеть держит страж
  // .github/scripts/compose-networks.mjs (правило `joined`); здесь проверяется
  // ровно то, что эти два решения не разъехались.
  assert.ok(
    services.get('agents').networks.includes('mcp'),
    `${COMPOSE}: у службы agents есть ${entry.urlEnv}, но сети mcp нет — имя не разрешится`,
  )
})

// Служба индекса проекта — второй сервер хоста (ADR 2026-10-04-0735, п. 1),
// её зовут агенты поиска. Собирается тем же способом «из источников», но оба
// источника здесь на Python: порт — умолчание `PORT` в `rag/serve.py`, путь —
// маршрут `Route("POST", ("/rag",), …)` там же. Без адреса `loadServers`
// положил бы `rag` в `skipped` МОЛЧА, и агент поиска говорил бы «поиск
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
    `${COMPOSE}: у службы agents нет ${entry.urlEnv}=${expected}; без него loadServers положит rag в skipped молча, и агент поиска скажет «поиск недоступен» при зелёной выкатке`,
  )
  // Адрес без сети — обещание без пути. Саму сеть держит страж
  // .github/scripts/compose-networks.mjs (правило `joined`); здесь проверяется
  // ровно то, что эти два решения не разъехались.
  assert.ok(
    services.get('agents').networks.includes('rag'),
    `${COMPOSE}: у службы agents есть ${entry.urlEnv}, но сети rag нет — имя не разрешится`,
  )
})
