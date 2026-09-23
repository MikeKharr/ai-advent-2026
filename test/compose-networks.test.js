// Изоляция службы MCP в отдельной сети compose — ADR 2026-09-23-1227, п. 5,
// условие вето compliance. Страж — .github/scripts/compose-networks.mjs, он же
// шаг «Изоляция сети mcp» в ci.yml. Здесь он показан и зелёным на настоящем
// deploy/compose.yml, и красным на приманках: правило «mcp не видит router и
// agents» должно ломаться на правке файла, а не держаться комментарием.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { COMPOSE, parseServices, problems } from '../.github/scripts/compose-networks.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TEXT = readFileSync(join(ROOT, COMPOSE), 'utf8')

test('настоящий compose.yml: нарушений нет', () => {
  assert.deepEqual(problems(TEXT), [])
})

test('разбор видит сети там, где они есть, и их отсутствие там, где их нет', () => {
  const services = parseServices(TEXT)
  assert.deepEqual(services.get('mcp'), ['mcp'])
  assert.deepEqual(services.get('caddy'), ['default', 'mcp', 'edge'])
  // Ключа networks нет — значит сеть по умолчанию, вместе с secrets.env.
  assert.equal(services.get('router'), null)
  assert.equal(services.get('agents'), null)
})

test('приманка: у mcp убрали ключ networks — он оказался в сети по умолчанию', () => {
  const decoy = TEXT.replace(/ {4}networks:\n {6}- mcp\n/, '')
  assert.notEqual(decoy, TEXT, 'приманка не подставилась — проверьте форму блока networks у mcp')
  assert.match(problems(decoy).join('\n'), /нет ключа networks/)
})

test('приманка: mcp добавили в сеть по умолчанию вдобавок к своей', () => {
  const decoy = TEXT.replace(/( {4}networks:\n {6}- mcp\n)/, '$1      - default\n')
  assert.notEqual(decoy, TEXT)
  assert.match(problems(decoy).join('\n'), /только в сети mcp/)
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
