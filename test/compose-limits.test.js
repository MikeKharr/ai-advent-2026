// Потолки памяти и ядер у служб индекса проекта — ADR 2026-09-29-1639, п. 4.
// Страж — .github/scripts/compose-limits.mjs, он же шаг «Потолки памяти и ядер
// у ollama и rag» в ci.yml. Здесь он показан и зелёным на настоящем
// deploy/compose.yml, и красным на приманках.
//
// Ради чего: эмбеддер — первый жилец машины, который берёт память гигабайтами,
// а машина общая: после апгрейда 2026-10-02 на ней ~7900 МиБ, из них под
// ollama и rag решением отдано 4608 (ADR 2026-10-02-1519). Снятый `mem_limit` не
// ломает ничего видимого — compose рабочий, поиск работает, — и обнаруживается
// он тем, что однажды ядро убивает не эмбеддер, а день. Поэтому правило
// обязано краснеть от снятия строки, а не держаться комментарием рядом с ней
// (I-14).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { COMPOSE, LIMITS, parseLimits, problems } from '../.github/scripts/compose-limits.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TEXT = readFileSync(join(ROOT, COMPOSE), 'utf8')

/**
 * Правка внутри блока одной службы. Без привязки к имени приманка попала бы в
 * первую попавшуюся службу с тем же куском текста: `oom_score_adj: 500` стоит
 * и у ollama, и у rag.
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

test('настоящий compose.yml: потолки на месте и те самые', () => {
  assert.deepEqual(problems(TEXT), [])
})

test('разбор видит значения там, где они есть, и их отсутствие там, где их нет', () => {
  const services = parseLimits(TEXT)
  assert.deepEqual(services.get('ollama'), LIMITS.ollama)
  assert.deepEqual(services.get('rag'), LIMITS.rag)
  // У остальных служб потолков нет — и страж об этом молчит намеренно:
  // кластер потолков для них решает владелец, здесь его не проверяют.
  assert.deepEqual(services.get('router'), {})
  assert.deepEqual(services.get('day1'), {})
})

// --- мутации: снятие защищающей строки ---------------------------------------

test('приманка: у ollama убрали mem_limit — потолка памяти нет, compose рабочий', () => {
  const decoy = inService(TEXT, 'ollama', /\n {4}mem_limit: 4g/, '')
  assert.equal(parseLimits(decoy).get('ollama').mem_limit, undefined, 'приманка не собралась')
  assert.match(problems(decoy).join('\n'), /у службы ollama нет ключа mem_limit/)
})

test('приманка: у ollama убрали cpus — сборка индекса вправе занять оба ядра', () => {
  const decoy = inService(TEXT, 'ollama', /\n {4}cpus: 1\.0/, '')
  assert.match(problems(decoy).join('\n'), /у службы ollama нет ключа cpus/)
})

test('приманка: у ollama убрали oom_score_adj — при тесноте ядро выбирает жертву само', () => {
  const decoy = inService(TEXT, 'ollama', /\n {4}oom_score_adj: 500/, '')
  assert.match(problems(decoy).join('\n'), /у службы ollama нет ключа oom_score_adj/)
})

test('приманка: у rag убрали mem_limit', () => {
  const decoy = inService(TEXT, 'rag', /\n {4}mem_limit: 512m/, '')
  assert.match(problems(decoy).join('\n'), /у службы rag нет ключа mem_limit/)
})

test('приманка: у rag убрали cpus', () => {
  const decoy = inService(TEXT, 'rag', /\n {4}cpus: 0\.5/, '')
  assert.match(problems(decoy).join('\n'), /у службы rag нет ключа cpus/)
})

test('приманка: у rag убрали oom_score_adj', () => {
  const decoy = inService(TEXT, 'rag', /\n {4}oom_score_adj: 500/, '')
  assert.match(problems(decoy).join('\n'), /у службы rag нет ключа oom_score_adj/)
})

// --- мутации: потолок остался, но перестал что-либо значить -------------------
// Проверка присутствия ключа этих двух не поймала бы, а именно так потолок и
// снимают на деле: не удаляя строку, а поднимая число.

test('приманка: mem_limit поднят до 8g — на машине с 8 ГБ это вся память, а не потолок', () => {
  const decoy = inService(TEXT, 'ollama', /mem_limit: 4g/, 'mem_limit: 8g')
  assert.match(problems(decoy).join('\n'), /у службы ollama mem_limit: 8g, а решением принято 4g/)
})

test('приманка: cpus поднят до 2.0 — обещание «второе ядро остаётся дням» снято', () => {
  const decoy = inService(TEXT, 'ollama', /cpus: 1\.0/, 'cpus: 2.0')
  assert.match(problems(decoy).join('\n'), /у службы ollama cpus: 2\.0, а решением принято 1\.0/)
})

test('приманка: oom_score_adj опущен до нуля — жертвой снова может стать день', () => {
  const decoy = inService(TEXT, 'rag', /oom_score_adj: 500/, 'oom_score_adj: 0')
  assert.match(problems(decoy).join('\n'), /у службы rag oom_score_adj: 0, а решением принято 500/)
})

test('службы ollama нет вовсе — это тоже нарушение, а не «ok»', () => {
  const decoy = TEXT.replace(/\n {2}ollama:\n(?: {4}.*\n| {6,}.*\n|\n)*/, '\n')
  assert.notEqual(decoy, TEXT)
  assert.match(problems(decoy).join('\n'), /службы ollama нет/)
})

test('непонятный файл — исключение, а не пустой список нарушений', () => {
  assert.throws(() => problems('version: "3"\n'), /не найден блок services/)
})
