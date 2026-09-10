import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseCompose } from '../lib/compose.js'
import { ROOT } from './helpers.js'

const text = readFileSync(join(ROOT, 'deploy/compose.yml'), 'utf8')

// Страж парсера. Парсер узкий: он читает подмножество формата, а не YAML.
// Страж — не пересчёт числа сервисов (это было бы то же чтение файла тем же
// способом, одна ошибка, посчитанная дважды), а требование к самому парсеру:
// встретив в блоке сервиса конструкцию не из подмножества, он обязан выдать
// находку. Тогда расширение файла роняет обязательную проверку, а не обедняет
// граф молча (ADR 2026-09-13-2000).
test('страж: на действующем compose.yml непонятых строк нет', () => {
  assert.deepEqual(parseCompose(text).findings, [])
})

test('страж: непонятая строка в блоке сервиса — находка с номером строки', () => {
  const broken = 'services:\n  a:\n    image: x\n    <<: *base\nvolumes:\n'
  const { findings } = parseCompose(broken)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].line, 4)
  assert.match(findings[0].message, /подмножеств/)
})

test('страж: depends_on в форме отображения не обнуляет зависимости молча', () => {
  const mapping = 'services:\n  a:\n    image: x\n    depends_on:\n      router:\n        condition: service_healthy\nvolumes:\n'
  const { services, findings } = parseCompose(mapping)
  assert.deepEqual(services[0].dependsOn, [])
  assert.equal(findings.length > 0, true, 'форма отображения прошла молча')
  assert.equal(findings[0].line, 5)
  assert.match(findings[0].message, /depends_on/)
})

test('страж: depends_on в поточной форме — находка', () => {
  const flow = 'services:\n  a:\n    image: x\n    depends_on: [router]\nvolumes:\n'
  const { findings } = parseCompose(flow)
  assert.equal(findings.length, 1)
  assert.match(findings[0].message, /depends_on/)
})

test('страж: том в длинной форме не теряется молча', () => {
  const long = 'services:\n  a:\n    image: x\n    volumes:\n      - type: volume\n        source: v\n        target: /data\nvolumes:\n  v:\n'
  const { services, findings } = parseCompose(long)
  assert.equal(findings.length > 0, true, 'длинная форма тома прошла молча')
  assert.deepEqual(
    services[0].volumes.filter((v) => v.named),
    [],
  )
})

test('том в короткой форме `имя: {}` — обычная запись, а не находка', () => {
  const short = 'services:\n  a:\n    image: x\n    volumes:\n      - day9_data:/data\nvolumes:\n  day9_data: {}\n'
  const { volumes, services, findings } = parseCompose(short)
  assert.deepEqual(findings, [])
  assert.deepEqual(volumes, ['day9_data'])
  assert.equal(services[0].volumes[0].named, true)
})

test('страж: настройки тома в верхнем блоке — находка', () => {
  const opts = 'services:\n  a:\n    image: x\nvolumes:\n  v:\n    driver: local\n'
  const { findings } = parseCompose(opts)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].line, 6)
})

test('расширение `x-*` — не выход за подмножество', () => {
  const extended = 'services:\n  a:\n    image: x\n    x-owner: platform\nvolumes:\n'
  assert.deepEqual(parseCompose(extended).findings, [])
})

test('состав деплоя: по сервису на строку image: и пять томов', () => {
  const parsed = parseCompose(text)
  const imageLines = text.split('\n').filter((l) => /^ {4}image:/.test(l)).length
  assert.equal(parsed.services.length, imageLines)
  // Тома считаются по файлу: девятый день принесёт свой, и равенство здесь
  // покрасило бы чужой PR (то же, что чинилось в проверке инвариантов).
  const declared = text.slice(text.lastIndexOf('\nvolumes:\n') + 1).split('\n').filter((l) => /^ {2}[a-z0-9_-]+:/.test(l)).length
  assert.equal(parsed.volumes.length, declared)
  for (const v of ['caddy_data', 'router_data']) assert.ok(parsed.volumes.includes(v), v)
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
  const days = parsed.services.filter((s) => /^day\d+$/.test(s.name)).length
  assert.equal(byName.caddy.dependsOn.length, days, 'caddy зависит от каждого дня')
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
  assert.deepEqual(parsed.findings, [])
})
