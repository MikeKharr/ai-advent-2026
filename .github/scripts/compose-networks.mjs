// Изоляция служб в отдельных сетях compose. Два правила, оба — условие вето
// compliance:
//   - `mcp` (ADR 2026-09-23-1227, п. 5, в части состава заменён ADR
//     2026-09-29-0236, п. 5): контейнер `mcp` живёт ТОЛЬКО в сети `mcp`, а в
//     сети `mcp` — `caddy`, сам `mcp` и `agents`. В сети по
//     умолчанию, где `router` с ключами провайдеров, службы нет:
//     оттуда не разрешается даже имя. Честно о том, чего правило больше НЕ
//     держит: `agents` из сети `mcp` достижим, и его порты 8082 и 8086
//     держат только ключи. Обещания «отрезано от agents» тут больше нет —
//     держится «отрезано от router и его ключей провайдеров».
//   - `rag` (ADR 2026-09-29-1639, п. 4; состав расширен ADR 2026-10-04-0735,
//     п. 1): `rag` и `ollama` живут ТОЛЬКО в сети `rag`, а в ней — только они,
//     `caddy` и `agents`. Что именно это держит: эмбеддер стоит ядра общей
//     машины, и у него нет ни ключа, ни лимитера своего. Единственное, чем он
//     закрыт, — что имя `ollama` не разрешается у `router`. Про `agents` это
//     больше НЕ так: ему имя `ollama`
//     разрешается, и обещание «отрезано от agents» тут снято — это названная
//     цена потребителя поиска у дня 22. `caddy` и `agents` в `joined`: без
//     первого не доходит /rag/healthz и выкатка краснела бы «единица не
//     отвечает» вместо «маршрут не туда», без второго агент поиска не
//     разрешает имя `rag` — поиск отказывает при зелёной выкатке.
//
// Правил `cron` и `tools` здесь больше нет: контейнер времени и серверы
// `mcpnews`/`mcpstore` удалены вместе с днями 18–20 (ADR 2026-10-20-0737).
// С ними ушла и проверка их изоляции — изолировать больше нечего, а строка
// `required` в прежних правилах краснела бы на самой пропаже службы.
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

/**
 * Правила изоляции.
 *
 * `network` — сеть; `allowed` — кто вправе в ней быть; `only` — кому положена
 * РОВНО ОДНА сеть, своя. `caddy` в `only` не входит намеренно: он вход, обе
 * сети ему положены по работе. Без этого различения `allowed` разрешал бы
 * изолируемой службе быть и в `mcp`, и в сети по умолчанию одновременно —
 * мостик из изолированной сети туда, где `router` с ключами (находка
 * `compliance` к PR дня 16).
 *
 * `agents` стоит в `allowed`, но не в `only`: ему сеть по умолчанию положена
 * по работе — по ней уходит запрос в роутер.
 *
 * `joined` — службы, которые ОБЯЗАНЫ объявить эту сеть, будучи при этом и в
 * других. Без него `allowed` был бы защитой в одну сторону: он краснеет, когда
 * в сеть войдёт кто не должен, но молчит, когда нужная связь исчезнет. У сети
 * `mcp` связь с `agents` — не терпимость, а условие работы третьего сервера
 * (ADR 2026-09-29-0236, п. 5): сняв две строки, получили бы запись `day16`
 * реестра серверов в `unreachable` при зелёном страже.
 *
 * `required` — службы, пропажа которых сама по себе нарушение. Она названа
 * отдельно от `only` потому, что `only` пропажу прощает осознанно (уехавшая
 * служба — не дыра, дыра была бы, останься она с двумя сетями), а вот
 * исчезновение изолируемой службы — повод покраснеть, а не повод сказать «ok».
 * Имя сети при этом именем службы быть не обязано: сеть `rag` держит две.
 */
export const RULES = [
  {
    network: 'mcp',
    required: ['mcp'],
    allowed: ['caddy', 'mcp', 'agents'],
    only: ['mcp'],
    joined: ['agents'],
  },
  {
    network: 'rag',
    required: ['rag', 'ollama'],
    allowed: ['caddy', 'rag', 'ollama', 'agents'],
    only: ['rag', 'ollama'],
    joined: ['caddy', 'agents'],
  },
]

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

  for (const rule of RULES) {
    // Изолируемые службы обязаны быть в файле: их пропажа — не «ok», а повод
    // посмотреть, куда они делись.
    const missing = rule.required.filter((name) => !services.has(name))
    for (const name of missing) found.push(`службы ${name} нет в ${COMPOSE}`)
    if (missing.length === rule.required.length) continue

    for (const name of rule.only) {
      // Уехавшая служба — не дыра: дыра была бы, останься она с двумя сетями.
      if (!services.has(name)) continue
      const networks = services.get(name)
      if (networks === null) {
        found.push(`у службы ${name} нет ключа networks: — она в сети по умолчанию, вместе с router и его ключами провайдеров`)
      } else if (networks.length !== 1 || networks[0] !== rule.network) {
        found.push(`служба ${name} должна быть только в сети ${rule.network}, а объявлена в: ${networks.join(', ') || '(пусто)'}`)
      }
    }

    for (const [name, networks] of services) {
      if (networks === null || !networks.includes(rule.network)) continue
      if (!rule.allowed.includes(name)) {
        found.push(`служба ${name} в сети ${rule.network}: там разрешены только ${rule.allowed.join(', ')}`)
      }
    }

    // Связь, снятая молча, — такая же дыра в проверке, как связь лишняя.
    for (const name of rule.joined ?? []) {
      const networks = services.get(name) ?? null
      if (networks === null || !networks.includes(rule.network)) {
        found.push(
          `служба ${name} обязана быть в сети ${rule.network}, а объявлена в: ${networks?.join(', ') || '(сеть по умолчанию)'}`,
        )
      }
    }
  }
  return found
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const found = problems(readFileSync(join(process.cwd(), COMPOSE), 'utf8'))
  for (const problem of found) console.log(`::error file=${COMPOSE}::${problem}`)
  if (found.length) {
    console.log(
      '::error::изоляция сетей нарушена — ADR 2026-09-23-1227, п. 5; 2026-09-29-0236, п. 5; 2026-09-29-1639, п. 4',
    )
    process.exit(1)
  }
  for (const rule of RULES) {
    console.log(
      `ok: ${rule.only.join(' и ')} — каждая только в сети ${rule.network}; в сети ${rule.network} — только ${rule.allowed.join(', ')}` +
        (rule.joined ? `; ${rule.joined.join(' и ')} — обязательно в ней` : ''),
    )
  }
}
