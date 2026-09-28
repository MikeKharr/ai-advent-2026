// Запреты и обещания страницы — механически, по исходному тексту.
//
// ЧЕСТНО О МЕТОДЕ: проверки здесь СТРУКТУРНЫЕ. Поведение ими не доказывается —
// оно доказано исполнением в trace.test.js и server.test.js. Здесь предмет сам
// текстовый: обращения к localStorage не должно быть, подстановки разметки
// строкой не должно быть, подпись у поля и aria-live должны быть.
//
// Снятие комментариев обязательно: слова «localStorage здесь нет» в
// комментарии проверка по сырому тексту прочла бы как присутствие и покраснела
// бы на верном коде. Само снятие проверяется первым тестом.

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const dir = join(here, '..', 'public')
const read = (name) => readFileSync(join(dir, name), 'utf8')

function stripJs(source) {
  let out = ''
  let i = 0
  let quote = null
  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]
    if (quote) {
      if (c === '\\') { out += c + (next ?? ''); i += 2; continue }
      if (c === quote) quote = null
      out += c
      i += 1
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i += 1; continue }
    if (c === '/' && next === '/') { while (i < source.length && source[i] !== '\n') i += 1; continue }
    if (c === '/' && next === '*') { i = source.indexOf('*/', i + 2) + 2; continue }
    out += c
    i += 1
  }
  return out
}
const stripHtml = (source) => source.replace(/<!--[\s\S]*?-->/g, '')

const scripts = readdirSync(dir).filter((f) => f.endsWith('.js'))
const code = scripts.map((f) => stripJs(read(f))).join('\n')
const raw = scripts.map((f) => read(f)).join('\n')
const page = stripHtml(read('index.html'))

test('снятие комментариев не съело код — иначе все запреты ниже зелены впустую', () => {
  assert.ok(scripts.length >= 3, `модулей страницы найдено ${scripts.length}`)
  assert.ok(code.includes('document.getElementById'), 'из app.js пропал код')
  assert.ok(code.includes('export function parseCall'), 'из trace.js пропал код')
  // А комментарии — съело: в них запреты названы словами.
  assert.equal(code.includes('scrollIntoView'), false)
  assert.equal(raw.includes('scrollIntoView'), true, 'в исходнике слово есть — значит, сняли именно комментарий')
})

test('страница ничего не хранит в браузере (I-10 и обещание подвала)', () => {
  for (const name of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie'])
    assert.ok(!code.includes(name), `${name} на странице`)
})

test('разметка строкой не подставляется: предмет показа кладётся текстом', () => {
  for (const name of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write'])
    assert.ok(!code.includes(name), `${name} на странице`)
  assert.ok(code.includes('textContent'), 'текстом — кладётся')
})

test('позиция чтения принадлежит посетителю', () => {
  for (const name of ['scrollIntoView', 'scrollTo(', 'scrollTop'])
    assert.ok(!code.includes(name), `${name} на странице`)
})

test('у каждого поля ввода есть подпись, связанная с ним', () => {
  const ids = [...page.matchAll(/<input[^>]*\bid="([^"]+)"/g)].map((m) => m[1])
  const labels = [...page.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map((m) => m[1])
  const wrapped = [...page.matchAll(/<label[^>]*>\s*<input[^>]*\bid="([^"]+)"/g)].map((m) => m[1])
  for (const id of ids)
    assert.ok(labels.includes(id) || wrapped.includes(id), `у поля #${id} нет подписи`)
})

test('состояние загрузки объявляется: есть область с aria-live', () => {
  assert.match(page, /aria-live="polite"/)
  assert.match(page, /role="status"/)
})

test('без JavaScript страница говорит об этом, а не молчит пустотой', () => {
  const noscript = page.slice(page.indexOf('<noscript>'), page.indexOf('</noscript>'))
  assert.ok(noscript.includes('Включите JavaScript'))
})

test('каждая рамка тела подписана и достижима с клавиатуры', () => {
  const trace = stripJs(read('trace.js'))
  assert.ok(trace.includes('aria-labelledby'), 'рамка тела не подписана')
  assert.ok(trace.includes('box.tabIndex = 0'), 'в рамку с прокруткой не попасть с клавиатуры')
})

test('ключей и секретов в клиентском коде нет (I-1)', () => {
  for (const name of ['AGENT_KEY', 'MCP_KEY', 'ANTHROPIC_API_KEY', 'Bearer', 'authorization'])
    assert.ok(!code.includes(name), `${name} в клиентском коде`)
})

test('кнопки «запустить» на экране нет: «когда» решает планировщик, не посетитель', () => {
  // Предмет — отсутствие управляющего элемента, и он текстовый. Что сервер
  // такой ручки не отдаёт, доказано исполнением в server.test.js.
  const buttons = [...page.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1].trim())
  assert.deepEqual(buttons, [], `на экране есть кнопки: ${buttons.join(', ')}`)
  assert.ok(!code.includes("method: 'POST'"), 'страница куда-то шлёт POST')
})
