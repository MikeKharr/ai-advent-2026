import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_WINDOW_MS, parseReset, readQuota } from '../src/adapters/quota.js'

const NOW = Date.parse('2026-09-09T12:00:00Z')
const headers = (o) => ({ get: (k) => o[k] ?? null })

test('длительности Groq разбираются во всех формах', () => {
  assert.equal(parseReset('577ms', NOW) - NOW, 577)
  assert.equal(parseReset('38.407s', NOW) - NOW, 38_407)
  assert.equal(parseReset('2m52.8s', NOW) - NOW, 172_800)
  assert.equal(parseReset('1h', NOW) - NOW, 3_600_000)
})

test('метка времени Anthropic разбирается как есть', () => {
  assert.equal(parseReset('2026-09-09T12:01:00Z', NOW) - NOW, 60_000)
})

test('голое число — не год: такая строка отвергается', () => {
  // Date.parse('60') читает это как 1960 год и отправляет сброс в прошлое.
  // Тогда квота всегда выглядит полной, и вся проверка молча выключается.
  for (const raw of ['60', '7', '0', '2026']) assert.equal(parseReset(raw, NOW), null, raw)
})

test('мусор и подделки под длительность отвергаются', () => {
  for (const raw of ['abc', '-5s', '1e9s', '', '   ', null, undefined, 42])
    assert.equal(parseReset(raw, NOW), null, String(raw))
})

test('окно сброса ограничено сверху: иначе квота не протухнет никогда', () => {
  assert.equal(parseReset('999999999s', NOW) - NOW, MAX_WINDOW_MS)
})

test('заголовки Groq и Anthropic читаются каждый по-своему', () => {
  const groq = readQuota(
    headers({
      'x-ratelimit-limit-tokens': '8000',
      'x-ratelimit-remaining-tokens': '7923',
      'x-ratelimit-reset-tokens': '577ms',
    }),
    'groq',
    NOW,
  )
  assert.deepEqual(groq, {
    limitTokens: 8000,
    remainingTokens: 7923,
    resetAt: NOW + 577,
    at: NOW,
  })

  const anthropic = readQuota(
    headers({
      'anthropic-ratelimit-input-tokens-limit': '10000000',
      'anthropic-ratelimit-input-tokens-remaining': '9995000',
      'anthropic-ratelimit-input-tokens-reset': '2026-09-09T12:01:00Z',
    }),
    'anthropic',
    NOW,
  )
  assert.equal(anthropic.remainingTokens, 9_995_000)
  assert.equal(anthropic.resetAt - NOW, 60_000)
})

test('провайдер без заголовков квоты — «неизвестно», а не «исчерпано»', () => {
  assert.equal(readQuota(headers({}), 'ollama', NOW), null)
  assert.equal(readQuota(undefined, 'groq', NOW), null)
})

test('отрицательный остаток — это ноль, а не «неизвестно»', () => {
  // Провайдеры отдают минус именно при исчерпании. Прочитать это как
  // «не знаем» значит пойти звать заведомо исчерпанного провайдера.
  const q = readQuota(
    headers({ 'x-ratelimit-limit-tokens': '8000', 'x-ratelimit-remaining-tokens': '-42' }),
    'groq',
    NOW,
  )
  assert.equal(q.remainingTokens, 0)
})

test('нечисловой остаток — «неизвестно»; время сброса необязательно', () => {
  const q = readQuota(
    headers({ 'x-ratelimit-limit-tokens': '8000', 'x-ratelimit-remaining-tokens': 'много' }),
    'groq',
    NOW,
  )
  assert.equal(q.remainingTokens, null)
  assert.equal(q.limitTokens, 8000)
  assert.equal(q.resetAt, null)
})
