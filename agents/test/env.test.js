// Окружение сервиса: каждая переменная, которую читает код, обязана
// существовать в `parseEnv`. Тест родился из находки гейта `compliance` по
// PR #183: `PAUSE_TTL_MINUTES` и `STAGE_LOG_FILE` были объявлены в ADR,
// использованы в коде и не заведены здесь, а тесты подставляли своё
// окружение и потому были слепы. Значения берутся из настоящего `parseEnv`,
// а не из фикстуры, — иначе этот класс ошибки вернётся на следующей
// переменной.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseEnv } from '../src/env.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** Все файлы кода сервиса: `src/` со вложенными каталогами и точка входа. */
function sources(dir = join(root, 'src'), found = [join(root, 'server.js')]) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sources(path, found)
    else if (name.endsWith('.js')) found.push(path)
  }
  return found
}

/** Обращения вида `env.ИМЯ` в коде — то, что сервис обещает себе прочитать. */
function usedKeys() {
  const keys = new Set()
  for (const file of sources()) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)) keys.add(match[1])
  }
  return [...keys].sort()
}

test('каждая переменная, которую читает код, есть в parseEnv', () => {
  // Минимальное окружение прода: два обязательных ключа и ничего больше.
  const { env, errors } = parseEnv({ AGENT_KEY: 'k', ROUTER_APP_KEY: 'a' })
  assert.deepEqual(errors, [], 'минимальное окружение принимается без ошибок')

  const missing = usedKeys().filter((key) => env[key] === undefined)
  assert.deepEqual(missing, [], `нет в parseEnv: ${missing.join(', ')}`)

  // Число, ставшее NaN, хуже отсутствия: `setTimeout(NaN)` — это 1 мс.
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'number') assert.ok(Number.isFinite(value), `${key} не число`)
    if (typeof value === 'string') assert.notEqual(value, '', `${key} пуст`)
  }
})

test('умолчания дня 13: срок паузы 60 минут, журнал этапов на томе', () => {
  const { env } = parseEnv({ AGENT_KEY: 'k', ROUTER_APP_KEY: 'a' })
  assert.equal(env.PAUSE_TTL_MINUTES, 60)
  assert.equal(env.PAUSE_TTL_MINUTES * 60_000, 3_600_000, 'срок в миллисекундах считается')
  assert.equal(env.STAGE_LOG_FILE, '/data/stage-log.csv')
})

test('журнал этапов и срок паузы задаются окружением', () => {
  const { env, errors } = parseEnv({
    AGENT_KEY: 'k',
    ROUTER_APP_KEY: 'a',
    STAGE_LOG_FILE: '/data/other.csv',
    PAUSE_TTL_MINUTES: '15',
  })
  assert.deepEqual(errors, [])
  assert.equal(env.STAGE_LOG_FILE, '/data/other.csv')
  assert.equal(env.PAUSE_TTL_MINUTES, 15)
})
