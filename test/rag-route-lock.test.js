// Маршрут `/rag` и его замок не разъезжаются — ADR 2026-09-29-2139, п. 1.
//
// Ради чего. Заход 3 сознательно НЕ добавил `handle /rag` в `deploy/Caddyfile`,
// хотя единица уже стояла в проде: за этим адресом ядро общей машины, и
// публичной ручки без ключа не должно существовать ни минуты. Заход 4
// добавляет маршрут и замок одним изменением. Дальше это держать нечем:
// убрать `env_file` у `rag`, поменять окно ручки на `open`, снять `header_up`
// или убрать отказ старта без ключа — правки на одну строку, каждая из
// которых оставляет compose рабочим, Caddy валидным, а прод — с открытой
// ручкой или с ручкой, за которой никого нет. Поэтому правило обязано
// краснеть от снятия строки, а не держаться комментарием рядом с ней (I-14).
//
// `required` у `rag.env` здесь НЕ проверяется: значение флага — решение
// владельца 2026-09-30 (`false`), и оно ничего не запирает. Замок — отказ
// старта в `rag/serve.py`, `main`, и он проверяется правилом 5 ниже и
// `test_serve.py::KeyRequiredTest`.
//
// Граница честная. Тест читает ТЕКСТ трёх файлов и держит связку между ними:
// «маршрут объявлен → ключ обязателен во всех трёх местах». Что служба
// действительно отвечает пустым 404 на негодный ключ, держат тесты единицы
// (`rag/test/test_serve.py`, `KeyTest`); что число потолка памяти то самое —
// `test/compose-limits.test.js`. Здесь — только то, что три файла говорят
// одно и то же.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

export const FILES = {
  caddy: 'deploy/Caddyfile',
  compose: 'deploy/compose.yml',
  serve: 'rag/serve.py',
}

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

/** Блок службы `rag` в compose: от `\n  rag:` до следующей службы. */
function ragService(compose) {
  const marker = '\n  rag:\n'
  const start = compose.indexOf(marker)
  if (start === -1) return ''
  const rest = compose.slice(start + marker.length)
  const next = rest.search(/^ {2}[A-Za-z0-9_.-]+:\s*$/m)
  return next === -1 ? compose.slice(start) : compose.slice(start, start + marker.length + next)
}

/**
 * Что не так. Пустой список — всё на месте.
 *
 * Принимает тексты, а не пути: на приманках тот же разбор гоняется красным.
 */
export function problems({ caddy, compose, serve }) {
  const out = []

  // 1. Маршрут объявлен на входе. `handle /rag {` — точное совпадение пути в
  //    Caddy, то есть именно та ручка, а не `/rag/healthz` и не `/ragged`.
  const routed = /\n\thandle \/rag \{/.test(caddy)
  if (!routed) out.push('в Caddyfile нет блока `handle /rag` — поверхность MCP наружу не опубликована')

  // 2. Адрес клиента подменяется входом. На нём стоят поадресные окна
  //    лимитера: без замены их обходят подставленным заголовком.
  const ragBlock = caddy.match(/\n\thandle \/rag \{[\s\S]*?\n\t\}/)?.[0] ?? ''
  if (routed && !ragBlock.includes('header_up X-Forwarded-For {client_ip}')) {
    out.push('в блоке `handle /rag` нет header_up X-Forwarded-For {client_ip} — окна лимитера обходятся заголовком')
  }

  // 3. Файл с ключом подключён к службе. Проверяется НАЛИЧИЕ записи, а не
  //    `required: true`: флаг снят решением владельца 2026-09-30 (см.
  //    комментарий в compose.yml — отказ всё равно красный, разница в
  //    радиусе). Замок — отказ старта в serve.py, а не строка в compose;
  //    но если убрать сам env_file, ключу неоткуда взяться, и маршрут
  //    останется без службы навсегда.
  const rag = ragService(compose)
  if (!rag) out.push('в compose.yml нет службы rag')
  else if (!/- path: \.\/rag\.env/.test(rag)) {
    out.push('у службы rag не подключён rag.env — ключу неоткуда взяться')
  }

  // 4. Ручка `/rag` объявлена в таблице маршрутов службы с окном, а не как
  //    исключение. `open` тут значило бы «без ключа и без окон».
  if (!/Route\("POST", \("\/rag",\), "call"/.test(serve)) {
    out.push('в rag/serve.py ручка POST /rag объявлена не с окном "call"')
  }

  // 5. Отказ старта без ключа. Держатель стоит на МЕСТЕ проверки, а не на
  //    функции: без этих строк `main` дошёл бы до `serve_forever` с пустым
  //    ключом, и годным оказался бы пустой `Authorization: Bearer `.
  if (!/if not key:\n\s+print\("::error::RAG_KEY/.test(serve)) {
    out.push('в rag/serve.py main() не отказывается стартовать без RAG_KEY')
  }

  return out
}

const REAL = { caddy: read(FILES.caddy), compose: read(FILES.compose), serve: read(FILES.serve) }

test('настоящие файлы: маршрут объявлен и замок на месте во всех трёх', () => {
  assert.deepEqual(problems(REAL), [])
})

// --- приманки: снятие защищающей строки ------------------------------------
//
// Каждая правит РОВНО ту строку, о которой говорит правило, и каждая
// оставляет файл рабочим: это и есть то, что иначе прошло бы ревью.

test('приманка: у службы rag убран env_file — ключу неоткуда взяться', () => {
  const decoy = { ...REAL, compose: REAL.compose.replace(/\n {6}- path: \.\/rag\.env\n {8}required: \w+/, '') }
  assert.notEqual(decoy.compose, REAL.compose, 'приманка не подставилась')
  assert.match(problems(decoy).join('\n'), /не подключён rag\.env/)
})

test('приманка: блок handle /rag убран — маршрута наружу нет', () => {
  const decoy = { ...REAL, caddy: REAL.caddy.replace(/\n\thandle \/rag \{[\s\S]*?\n\t\}/, '') }
  assert.notEqual(decoy.caddy, REAL.caddy, 'приманка не подставилась')
  assert.match(problems(decoy).join('\n'), /нет блока `handle \/rag`/)
})

test('приманка: из блока handle /rag убран header_up — окна лимитера обходятся', () => {
  const block = REAL.caddy.match(/\n\thandle \/rag \{[\s\S]*?\n\t\}/)[0]
  const stripped = block.replace(/\n\t\t\theader_up X-Forwarded-For \{client_ip\}/, '')
  assert.notEqual(stripped, block, 'приманка не подставилась')
  const decoy = { ...REAL, caddy: REAL.caddy.replace(block, stripped) }
  assert.match(problems(decoy).join('\n'), /header_up X-Forwarded-For/)
})

test('приманка: ручка /rag объявлена исключением из окон', () => {
  const decoy = {
    ...REAL,
    serve: REAL.serve.replace('Route("POST", ("/rag",), "call"', 'Route("POST", ("/rag",), "open"'),
  }
  assert.notEqual(decoy.serve, REAL.serve, 'приманка не подставилась')
  assert.match(problems(decoy).join('\n'), /не с окном "call"/)
})

test('приманка: main() перестал отказываться стартовать без ключа', () => {
  const decoy = { ...REAL, serve: REAL.serve.replace('if not key:', 'if False:') }
  assert.notEqual(decoy.serve, REAL.serve, 'приманка не подставилась')
  assert.match(problems(decoy).join('\n'), /не отказывается стартовать без RAG_KEY/)
})

// Разбор обязан ВИДЕТЬ значения там, где они есть, а не молчать всегда:
// страж, у которого выражение не совпадает ни с чем, зелен на всём подряд.
test('разбор находит блок службы rag и не путает его с соседней', () => {
  const rag = ragService(REAL.compose)
  assert.match(rag, /image: ghcr\.io\/mikekharr\/advent-rag/)
  assert.doesNotMatch(rag, /image: ollama\//, 'блок съел соседнюю службу')
})
