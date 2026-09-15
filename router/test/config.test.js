// Продовая конфигурация — такой же источник отказа на старте, как код, но до
// сих пор её не читал ни один тест (находка гейтов по PR #140). Здесь она
// грузится настоящим loadConfig на фиктивных ключах.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { loadConfig, orderedCandidates } from '../src/config.js'

const read = (name) => JSON.parse(readFileSync(new URL(`../config/${name}`, import.meta.url), 'utf8'))
const providers = read('providers.json')
const classes = read('classes.json')
const apps = read('apps.json')

// Ключи фиктивные: проверяется полнота конфигурации, а не доступ к провайдеру.
const ENV_PROD = {
  ANTHROPIC_API_KEY: 'ci-dummy',
  GROQ_API_KEY: 'ci-dummy',
  KIMI_API_KEY: 'ci-dummy',
  ROUTER_ADMIN_KEY: 'ci-dummy',
  APP_KEY_SMOKE: 'ci-dummy',
  APP_KEY_DAY5: 'ci-dummy',
  APP_KEY_AGENTS: 'ci-dummy',
}

const kimi = providers.filter((p) => p.kind === 'kimi')

test('продовая конфигурация загружается: роутер с записями Kimi стартует', () => {
  const config = loadConfig({ providers, classes, apps, env: ENV_PROD })
  assert.equal(config.providers.length, providers.length)
})

test('четыре записи Kimi на одном ключе и одной ёмкости', () => {
  assert.deepEqual(
    kimi.map((p) => p.id),
    ['kimi-k3', 'kimi-k2.6', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed'],
  )
  for (const p of kimi) {
    assert.equal(p.secretEnv, 'KIMI_API_KEY', `${p.id}: общий секрет`)
    assert.equal(p.maxConcurrency, 15, `${p.id}: одна ёмкость на хост`)
    assert.equal(p.explicitOnly, true, `${p.id}: только явный выбор`)
    // Поле выражает оркестрацию, а не границу выхода данных (PR #140).
    assert.deepEqual(p.dataClasses, ['public', 'internal', 'personal'], p.id)
  }
})

test('без KIMI_API_KEY роутер не стартует целиком, а не теряет один класс', () => {
  assert.throws(
    () => loadConfig({ providers, classes, apps, env: { ...ENV_PROD, KIMI_API_KEY: '' } }),
    /KIMI_API_KEY/,
  )
})

test('Kimi не участвует в политике ни одного класса, но доступен по имени', () => {
  for (const [name, cls] of Object.entries(classes)) {
    const policy = orderedCandidates(cls, providers).map((p) => p.id)
    assert.deepEqual(
      policy.filter((id) => id.startsWith('kimi-')),
      [],
      `класс ${name}: автоматическая маршрутизация Kimi не берёт`,
    )
  }
  // Явный выбор допустим там, где класс включает ярус cloud-frontier.
  const explicit = orderedCandidates(classes.other, providers, { explicit: true }).map((p) => p.id)
  assert.deepEqual(explicit.filter((id) => id.startsWith('kimi-')), kimi.map((p) => p.id))
})
