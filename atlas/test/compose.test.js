import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseCompose } from '../lib/compose.js'
import { ROOT } from './helpers.js'

const text = readFileSync(join(ROOT, 'deploy/compose.yml'), 'utf8')

// Страж парсера. Парсер узкий: он читает подмножество формата, а не YAML.
// Если файл выйдет за подмножество (иной отступ, якоря, `extends`), парсер
// молча увидит меньше — и граф обеднеет незаметно. Поэтому число сервисов и
// томов пересчитывается здесь вторым, независимым способом: по строкам
// `image:` (у каждого сервиса ровно одна) и по хвостовому блоку `volumes:`.
test('страж: парсер видит ровно столько сервисов и томов, сколько в файле', () => {
  const parsed = parseCompose(text)

  const imageLines = text.split('\n').filter((l) => /^ {4}image:/.test(l)).length
  assert.equal(
    parsed.services.length,
    imageLines,
    'сервисов найдено не столько, сколько строк image: — compose вышел за подмножество парсера',
  )

  const tail = text.slice(text.lastIndexOf('\nvolumes:\n') + 1)
  const volumeLines = tail.split('\n').filter((l) => /^ {2}[a-z0-9_-]+:\s*$/.test(l)).length
  assert.equal(
    parsed.volumes.length,
    volumeLines,
    'томов найдено не столько, сколько в верхнем блоке volumes:',
  )
})

test('страж: состав сервисов и томов — тот, что ожидается проектом', () => {
  const parsed = parseCompose(text)
  assert.deepEqual(
    parsed.services.map((s) => s.name).sort(),
    ['agents', 'caddy', 'day1', 'day2', 'day3', 'day4', 'day5', 'day6', 'day7', 'day8', 'router'].sort(),
  )
  // Пять томов — структура деплоя, а не растущее число (ADR 2026-09-13-2000).
  assert.equal(parsed.volumes.length, 5)
  assert.deepEqual(parsed.volumes.sort(), ['agents_data', 'caddy_config', 'caddy_data', 'day5_data', 'router_data'])
})

test('зависимости, тома и env_file сервиса разбираются', () => {
  const parsed = parseCompose(text)
  const byName = Object.fromEntries(parsed.services.map((s) => [s.name, s]))

  assert.deepEqual(byName.day5.dependsOn, ['router'])
  assert.deepEqual(
    byName.day5.volumes.map((v) => ({ source: v.source, target: v.target })),
    [{ source: 'day5_data', target: '/data' }],
  )
  assert.deepEqual(byName.day5.envFiles, ['./day5.env'])
  assert.equal(byName.caddy.image, 'caddy:2-alpine')
  assert.equal(byName.day1.image, 'ghcr.io/mikekharr/advent-day1:${DAY1_TAG:-latest}')
  assert.equal(byName.caddy.dependsOn.length, 8)
})

test('bind-монтирование отличается от именованного тома', () => {
  const parsed = parseCompose(text)
  const caddy = parsed.services.find((s) => s.name === 'caddy')
  const site = caddy.volumes.find((v) => v.source === '../site')
  assert.ok(site, 'bind-монтирование лендинга не найдено')
  assert.equal(site.named, false)
  assert.equal(caddy.volumes.find((v) => v.source === 'caddy_data').named, true)
})

test('комментарий в конце строки тома не попадает в цель монтирования', () => {
  const parsed = parseCompose('services:\n  a:\n    volumes:\n      - v:/data      # хвост\nvolumes:\n  v:\n')
  assert.deepEqual(parsed.services[0].volumes, [{ source: 'v', target: '/data', named: true }])
})
