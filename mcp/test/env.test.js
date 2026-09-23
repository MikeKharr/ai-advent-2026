import assert from 'node:assert/strict'
import test from 'node:test'
import { parseEnv } from '../src/env.js'

test('без MCP_KEY конфигурация битая: процесс не должен открыть порт', () => {
  const { errors } = parseEnv({})
  assert.deepEqual(errors, ['MCP_KEY не задан'])
})

test('умолчания: порт 8083 и окна лимитера', () => {
  const { env, errors } = parseEnv({ MCP_KEY: 'k' })
  assert.deepEqual(errors, [])
  assert.equal(env.PORT, 8083)
  assert.equal(env.RATE_LIMIT_PER_MIN, 10)
  assert.equal(env.RATE_LIMIT_PER_HOUR, 100)
  // Порог сигнала о переборе нарочно не равен рабочим окнам: другая
  // величина и другой смысл (см. комментарий в src/env.js).
  assert.equal(env.REFUSAL_SIGNAL_PER_HOUR, 60)
  assert.notEqual(env.REFUSAL_SIGNAL_PER_HOUR, env.RATE_LIMIT_PER_HOUR)
})

test('негодное число — ошибка, а не молчаливое умолчание', () => {
  const { errors } = parseEnv({ MCP_KEY: 'k', RATE_LIMIT_PER_MIN: 'много' })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /RATE_LIMIT_PER_MIN/)
})
