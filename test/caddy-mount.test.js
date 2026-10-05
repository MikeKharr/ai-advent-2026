// Конфигурация входа монтируется каталогом, а не одиночным файлом.
//
// Ради чего. Монтировка одиночного файла прибивает к точке монтирования inode.
// Обновление репозитория на сервере (шаг выкатки, `git reset --hard`) не правит
// файл на месте: оно создаёт новый файл и переименовывает его на то же имя —
// запись в каталоге указывает на новый inode, а контейнер входа продолжает
// читать старый. `caddy reload` в этом случае отвечает `config is unchanged`,
// то есть УСПЕХОМ, при отсутствующем снаружи маршруте: выкатка дня 22
// (2026-10-04) покраснела на живой проверке, а не на шаге перезагрузки.
// Возврат одной строки в compose.yml возвращает дефект целиком, оставляя
// compose рабочим и Caddy валидным, — поэтому правило обязано краснеть от
// правки строки, а не держаться комментарием рядом с ней (I-14).
//
// Граница честная. Тест читает ТЕКСТ deploy/compose.yml и держит нашу строку.
// Что монтировка каталога действительно показывает контейнеру новое
// содержимое — свойство докера и образа, а не нашего файла; его держит живым
// прогоном шаг CI «Правка Caddyfile доезжает до живого входа»
// (`.github/scripts/caddy-mount-check.sh`).
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

export const COMPOSE = 'deploy/compose.yml'
export const CADDYFILE = 'deploy/caddy/Caddyfile'

/** Блок службы `caddy`: от `\n  caddy:` до следующей службы. */
function caddyService(compose) {
  const marker = '\n  caddy:\n'
  const start = compose.indexOf(marker)
  if (start === -1) return ''
  const rest = compose.slice(start + marker.length)
  const next = rest.search(/^ {2}[A-Za-z0-9_.-]+:\s*$/m)
  return next === -1 ? compose.slice(start) : compose.slice(start, start + marker.length + next)
}

/**
 * Что не так. Пустой список — монтировка каталогом на месте.
 *
 * Принимает текст, а не путь: на приманках тот же разбор гоняется красным.
 */
export function problems(compose) {
  const out = []
  const caddy = caddyService(compose)
  if (!caddy) {
    out.push(`в ${COMPOSE} нет службы caddy — монтировать нечего`)
    return out
  }

  // Монтировки службы: `- <источник>:<цель>[:опции]`. Комментарии не в счёт.
  const mounts = [...caddy.matchAll(/^\s*- (\.[^\s:]*):(\/[^\s:]*)(?::([a-z,]+))?\s*$/gm)]
    .map(([, source, target, options]) => ({ source, target, options }))

  // 1. Любая монтировка, чья цель — сам файл конфигурации, и есть дефект:
  //    именно у неё прибит inode. Ловится по ЦЕЛИ, а не по источнику:
  //    переименование файла в репозитории дефект не чинит.
  for (const m of mounts) {
    if (/\/Caddyfile$/.test(m.target)) {
      out.push(
        `монтировка ${m.source}:${m.target} — одиночный файл: inode прибит, ` +
          'обновление репозитория на сервере заменит файл, а контейнер продолжит читать старый, ' +
          'и `caddy reload` ответит `config is unchanged`, то есть успехом'
      )
    }
  }

  // 2. Каталог конфигурации примонтирован, и источник — тот самый каталог.
  //    Без второй половины правило было бы зелёным на пустом каталоге.
  const dir = mounts.find((m) => m.target === '/etc/caddy')
  if (!dir) {
    out.push(`у службы caddy нет монтировки каталога в /etc/caddy — конфигурации у входа неоткуда взяться`)
  } else if (dir.source !== './caddy') {
    out.push(`каталог конфигурации монтируется из ${dir.source}, а конфигурация лежит в ./caddy`)
  } else if (dir.options !== 'ro') {
    out.push(`каталог конфигурации монтируется с опциями «${dir.options ?? 'без опций'}», а не :ro`)
  }

  return out
}

test('настоящий compose.yml: конфигурация входа монтируется каталогом ./caddy', () => {
  assert.deepEqual(problems(readFileSync(join(ROOT, COMPOSE), 'utf8')), [])
})

test('файл конфигурации лежит там, откуда его монтируют', () => {
  assert.ok(existsSync(join(ROOT, CADDYFILE)), `${CADDYFILE} не найден`)
})

// --- приманки ----------------------------------------------------------------

test('приманка: вернули монтировку одиночным файлом — дефект выкатки вернулся', () => {
  const text = readFileSync(join(ROOT, COMPOSE), 'utf8')
  const decoy = text.replace('      - ./caddy:/etc/caddy:ro\n', '      - ./caddy/Caddyfile:/etc/caddy/Caddyfile:ro\n')
  assert.notEqual(decoy, text, 'приманка не подставилась')
  const found = problems(decoy).join('\n')
  assert.match(found, /одиночный файл/)
  assert.match(found, /нет монтировки каталога в \/etc\/caddy/)
})

test('приманка: к каталогу добавили монтировку файлом — каталог есть, дефект тоже', () => {
  const text = readFileSync(join(ROOT, COMPOSE), 'utf8')
  const decoy = text.replace(
    '      - ./caddy:/etc/caddy:ro\n',
    '      - ./caddy:/etc/caddy:ro\n      - ./caddy/Caddyfile:/etc/caddy/Caddyfile:ro\n'
  )
  assert.notEqual(decoy, text, 'приманка не подставилась')
  assert.match(problems(decoy).join('\n'), /одиночный файл/)
})

test('приманка: монтировку каталога сняли вовсе', () => {
  const text = readFileSync(join(ROOT, COMPOSE), 'utf8')
  const decoy = text.replace('      - ./caddy:/etc/caddy:ro\n', '')
  assert.notEqual(decoy, text, 'приманка не подставилась')
  assert.match(problems(decoy).join('\n'), /нет монтировки каталога в \/etc\/caddy/)
})

test('приманка: каталог монтируется из другого места', () => {
  const text = readFileSync(join(ROOT, COMPOSE), 'utf8')
  const decoy = text.replace('      - ./caddy:/etc/caddy:ro\n', '      - ./conf:/etc/caddy:ro\n')
  assert.notEqual(decoy, text, 'приманка не подставилась')
  assert.match(problems(decoy).join('\n'), /монтируется из \.\/conf/)
})

test('приманка: сняли :ro — вход получил право писать в конфигурацию репозитория', () => {
  const text = readFileSync(join(ROOT, COMPOSE), 'utf8')
  const decoy = text.replace('      - ./caddy:/etc/caddy:ro\n', '      - ./caddy:/etc/caddy\n')
  assert.notEqual(decoy, text, 'приманка не подставилась')
  assert.match(problems(decoy).join('\n'), /а не :ro/)
})

test('службы caddy нет вовсе — это нарушение, а не «ok»', () => {
  assert.match(problems('services:\n  day1:\n    image: x\n').join('\n'), /нет службы caddy/)
})
