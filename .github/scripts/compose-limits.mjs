// Потолки памяти и ядер у служб индекса проекта — ADR 2026-09-29-1639, п. 4;
// mem_limit у ollama — ADR 2026-10-02-1519.
//
// Что держит этот страж и чего не держит. Держит: у служб `ollama` и `rag` в
// deploy/compose.yml стоят РОВНО те три ключа и РОВНО те значения, которыми
// принято решение. Снять `mem_limit` — одна строка, и compose остаётся
// рабочим: контейнер поднимается, поиск работает, а потолка нет. Заметить это
// чтением диффа можно, а прогоном — нельзя, поэтому правило здесь, а не в
// комментарии рядом со строкой.
//
// Не держит: что 4 ГБ хватит. Это выведенное число, а не замер (ADR
// 2026-10-02-1519): прежние 2 ГБ «хватало» по замеру на macOS — и раннер убило
// на linux. Страж следит, чтобы число не уехало молча, — уехать оно вправе, но
// новым решением и классом A, а не правкой файла.
//
// Сверка точным значением, а не «не больше»: `mem_limit: 8g` формально
// «потолок есть», и проверка присутствия на нём была бы зелёной. Общей машине
// от такого потолка ни холодно ни жарко — это вся её память.
//
// Почему только две службы: у остальных контейнеров потолков нет вовсе, это
// отдельный пункт бэклога владельцу. Вписывать их сюда значило бы покрасить
// прогон на том, чего не решали.
//
// Запуск из корня репозитория: node .github/scripts/compose-limits.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const COMPOSE = 'deploy/compose.yml'

/**
 * Откуда числа — в каждом сообщении об отказе. Человек при красном прогоне
 * читает именно его: одна ссылка на ADR 2026-09-29-1639 приписывала бы ему
 * `mem_limit: 4g`, которого в нём нет (там `2g`), и толкала бы «починить»
 * compose обратно (находка compliance к #292).
 */
export const SOURCE =
  'ADR 2026-09-29-1639, п. 4; mem_limit у ollama — ADR 2026-10-02-1519'

/** Служба → её потолки, дословно так, как они записаны в compose.yml. */
export const LIMITS = {
  ollama: { mem_limit: '4g', cpus: '1.0', oom_score_adj: '500' },
  rag: { mem_limit: '512m', cpus: '0.5', oom_score_adj: '500' },
}

const COMMENT = /^\s*#/

/**
 * Значения трёх ключей у каждой службы. Разбор — то же подмножество YAML, на
 * котором написан файл: службы на отступе 2, их ключи на 4. Неизвестная форма
 * строки службы — исключение: страж, который не понял файл, обязан покраснеть,
 * а не сказать «нарушений нет».
 */
export function parseLimits(text) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l === 'services:')
  if (start === -1) throw new Error(`${COMPOSE}: не найден блок services:`)

  const services = new Map()
  let service = null
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || COMMENT.test(line)) continue
    const indent = line.search(/\S/)
    if (indent === 0) break
    if (indent === 2) {
      const name = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line)
      if (!name) throw new Error(`${COMPOSE}: непонятная строка службы: ${line}`)
      service = name[1]
      services.set(service, {})
      continue
    }
    if (indent !== 4) continue
    const kv = /^ {4}(mem_limit|cpus|oom_score_adj):\s*(\S+)\s*$/.exec(line)
    if (kv) services.get(service)[kv[1]] = kv[2]
  }
  if (services.size === 0) throw new Error(`${COMPOSE}: в блоке services не найдено ни одной службы`)
  return services
}

/** Нарушения — списком строк. Пусто — потолки на месте и те самые. */
export function problems(text) {
  const services = parseLimits(text)
  const found = []
  for (const [name, expected] of Object.entries(LIMITS)) {
    if (!services.has(name)) {
      found.push(`службы ${name} нет в ${COMPOSE} — потолки ставить не на что`)
      continue
    }
    const actual = services.get(name)
    for (const [key, value] of Object.entries(expected)) {
      if (actual[key] === undefined) {
        found.push(`у службы ${name} нет ключа ${key}: — решением принято ${key}: ${value} (${SOURCE})`)
      } else if (actual[key] !== value) {
        found.push(`у службы ${name} ${key}: ${actual[key]}, а решением принято ${value}`)
      }
    }
  }
  return found
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const found = problems(readFileSync(join(process.cwd(), COMPOSE), 'utf8'))
  for (const problem of found) console.log(`::error file=${COMPOSE}::${problem}`)
  if (found.length) {
    console.log(`::error::потолки новых служб разошлись с решением — ${SOURCE}`)
    process.exit(1)
  }
  for (const [name, expected] of Object.entries(LIMITS)) {
    console.log(`ok: ${name} — ${Object.entries(expected).map(([k, v]) => `${k}: ${v}`).join(', ')}`)
  }
}
