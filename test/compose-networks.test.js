// Изоляция служб в отдельных сетях compose — ADR 2026-09-23-1227, п. 5 (служба
// MCP) и ADR 2026-09-28-0736, п. 6 (контейнер времени), оба — условие вето
// compliance. Страж — .github/scripts/compose-networks.mjs, он же шаг
// «Изоляция сетей mcp и cron» в ci.yml. Здесь он показан и зелёным на
// настоящем deploy/compose.yml, и красным на приманках: правила «mcp не видит
// router и agents» и «cron не видит никого, кроме agents» должны ломаться на
// правке файла, а не держаться комментарием.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { COMPOSE, parseServices, problems } from '../.github/scripts/compose-networks.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TEXT = readFileSync(join(ROOT, COMPOSE), 'utf8')

/**
 * Правка внутри блока одной службы. Без привязки к имени приманка попала бы в
 * первую попавшуюся службу с тем же куском текста — у day16 и mcp блоки
 * networks одинаковые, и приманка «испортили mcp» молча портила бы day16.
 */
function inService(text, name, from, to) {
  const marker = `\n  ${name}:\n`
  const start = text.indexOf(marker)
  assert.notEqual(start, -1, `службы ${name} нет в ${COMPOSE}`)
  const rest = text.slice(start + marker.length)
  const next = rest.search(/^ {2}[A-Za-z0-9_.-]+:\s*$/m)
  const end = next === -1 ? text.length : start + marker.length + next
  const block = text.slice(start, end)
  const patched = block.replace(from, to)
  assert.notEqual(patched, block, `приманка не подставилась в блок ${name}`)
  return text.slice(0, start) + patched + text.slice(end)
}

test('настоящий compose.yml: нарушений нет', () => {
  assert.deepEqual(problems(TEXT), [])
})

test('разбор видит сети там, где они есть, и их отсутствие там, где их нет', () => {
  const services = parseServices(TEXT)
  assert.deepEqual(services.get('mcp'), ['mcp'])
  assert.deepEqual(services.get('caddy'), ['default', 'mcp', 'edge'])
  // День 16 ходит только в службу MCP: в сети по умолчанию ему делать нечего.
  assert.deepEqual(services.get('day16'), ['mcp'])
  // Ключа networks нет — значит сеть по умолчанию, вместе с secrets.env.
  assert.equal(services.get('router'), null)
  // Контейнер времени и серверы MCP — каждый только в своей сети; agents в
  // трёх: по default к нему приходят дни 6–15, по cron — тик расписания, по
  // tools он сам ходит в серверы инструментов.
  assert.deepEqual(services.get('cron'), ['cron'])
  assert.deepEqual(services.get('mcpnews'), ['tools'])
  assert.deepEqual(services.get('mcpstore'), ['tools'])
  assert.deepEqual(services.get('agents'), ['default', 'cron', 'tools'])
})

test('приманка: у mcp убрали ключ networks — он оказался в сети по умолчанию', () => {
  const decoy = inService(TEXT, 'mcp', / {4}networks:\n {6}- mcp\n/, '')
  assert.match(problems(decoy).join('\n'), /нет ключа networks/)
})

test('приманка: mcp добавили в сеть по умолчанию вдобавок к своей', () => {
  const decoy = inService(TEXT, 'mcp', / {4}networks:\n {6}- mcp\n/, '    networks:\n      - mcp\n      - default\n')
  assert.match(problems(decoy).join('\n'), /только в сети mcp/)
})

// Мостик у дня 16 — главный сценарий стража: изоляция службы держится не
// тем, что до неё не дотянуться, а тем, что дотянуться не через кого. Судим
// по problems(), а не по разбору: проверка разборщика выглядела бы покрытием
// и им не была бы (находка `compliance` к PR дня 16).
test('приманка: день 16 добавили в сеть по умолчанию — мостик к secrets.env', () => {
  const decoy = inService(TEXT, 'day16', / {4}networks:\n {6}- mcp\n/, '    networks:\n      - mcp\n      - default\n')
  assert.deepEqual(parseServices(decoy).get('day16'), ['mcp', 'default'], 'приманка не собралась')
  assert.match(problems(decoy).join('\n'), /служба day16 должна быть только в сети mcp/)
})

test('приманка: у дня 16 убрали ключ networks — он в сети по умолчанию', () => {
  const decoy = inService(TEXT, 'day16', / {4}networks:\n {6}- mcp\n/, '')
  assert.match(problems(decoy).join('\n'), /у службы day16 нет ключа networks/)
})

test('приманка: router пустили в сеть mcp', () => {
  const decoy = TEXT.replace(
    /( {2}router:\n)( {4}image:)/,
    '$1    networks:\n      - default\n      - mcp\n$2',
  )
  assert.notEqual(decoy, TEXT)
  assert.match(problems(decoy).join('\n'), /служба router в сети mcp/)
})

test('службы mcp нет вовсе — это тоже нарушение, а не «ok»', () => {
  const decoy = TEXT.replace(/\n {2}mcp:\n(?: {4}.*\n| {6,}.*\n|\n)*/, '\n')
  assert.notEqual(decoy, TEXT)
  assert.match(problems(decoy).join('\n'), /службы mcp нет/)
})

test('непонятный файл — исключение, а не пустой список нарушений', () => {
  assert.throws(() => problems('version: "3"\n'), /не найден блок services/)
})

// --- Сеть cron (ADR 2026-09-28-0736, п. 6) ------------------------------------
// Контейнер времени держит копию AGENT_KEY. Отдельная сеть — единственное, что
// мешает ему дотянуться до router, дней и mcp; связность до agents дала бы и
// сеть по умолчанию, поэтому «работает» тут ничего не доказывает, и правило
// обязано ломаться правкой файла.

test('приманка: cron пустили в сеть по умолчанию вдобавок к своей', () => {
  const decoy = inService(TEXT, 'cron', / {4}networks:\n {6}- cron\n/, '    networks:\n      - cron\n      - default\n')
  assert.deepEqual(parseServices(decoy).get('cron'), ['cron', 'default'], 'приманка не собралась')
  assert.match(problems(decoy).join('\n'), /служба cron должна быть только в сети cron/)
})

test('приманка: у cron убрали ключ networks — он в сети по умолчанию', () => {
  const decoy = inService(TEXT, 'cron', / {4}networks:\n {6}- cron\n/, '')
  assert.match(problems(decoy).join('\n'), /у службы cron нет ключа networks/)
})

test('приманка: router пустили в сеть cron', () => {
  const decoy = TEXT.replace(
    /( {2}router:\n)( {4}image:)/,
    '$1    networks:\n      - default\n      - cron\n$2',
  )
  assert.notEqual(decoy, TEXT)
  assert.match(problems(decoy).join('\n'), /служба router в сети cron/)
})

test('приманка: у agents убрали сеть cron — тик перестал доходить, но молча', () => {
  const decoy = inService(TEXT, 'agents', / {6}cron:\n/, '')
  assert.deepEqual(parseServices(decoy).get('agents'), ['default', 'tools'], 'приманка не собралась')
  // Нарушения изоляции тут нет — и это честный предел стража: он держит, куда
  // cron НЕ может, а не то, что тик доходит. Второе держит первый тик в проде
  // («Стенд ≠ прод» в описании PR), и притворяться, что это проверено здесь,
  // нельзя.
  assert.deepEqual(problems(decoy), [])
})

test('службы cron нет вовсе — это тоже нарушение, а не «ok»', () => {
  const decoy = TEXT.replace(/\n {2}cron:\n(?: {4}.*\n| {6,}.*\n|\n)*/, '\n')
  assert.notEqual(decoy, TEXT)
  assert.match(problems(decoy).join('\n'), /службы cron нет/)
})

// --- Сеть tools (ADR 2026-09-28-0736, п. 3) ------------------------------------
// Серверы дней 19–20 не публикуются наружу. Держит это не отсутствие строки в
// Caddyfile, а то, что caddy в их сеть не входит: маршрут, дописанный по
// невнимательности, никуда не дошёл бы.

test('приманка: caddy пустили в сеть tools — сервер стало можно опубликовать', () => {
  const decoy = inService(TEXT, 'caddy', / {6}edge:\n/, '      tools:\n      edge:\n')
  assert.ok(parseServices(decoy).get('caddy').includes('tools'), 'приманка не собралась')
  assert.match(problems(decoy).join('\n'), /служба caddy в сети tools/)
})

test('приманка: mcpstore добавили в сеть по умолчанию — мостик к secrets.env', () => {
  const decoy = inService(TEXT, 'mcpstore', / {4}networks:\n {6}- tools\n/, '    networks:\n      - tools\n      - default\n')
  assert.match(problems(decoy).join('\n'), /служба mcpstore должна быть только в сети tools/)
})

test('службы mcpnews нет вовсе — это тоже нарушение, а не «ok»', () => {
  const decoy = TEXT.replace(/\n {2}mcpnews:\n(?: {4}.*\n| {6,}.*\n|\n)*/, '\n')
  assert.notEqual(decoy, TEXT)
  assert.match(problems(decoy).join('\n'), /службы mcpnews нет/)
})
