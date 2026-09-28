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

test('на экране есть место, где названы серверы запуска — смысл дня', () => {
  assert.match(page, /id="servers"/)
  assert.ok(stripJs(read('app.js')).includes('showServers'), 'список серверов не заполняется')
})

// Пояснение дня — предмет текстовый. Что запуск платный, сказать обязательно:
// это ровно то, чем день 20 отличается от бесплатной цепочки дня 19, и экран
// без этой строки предлагает нажать «Запустить», не назвав цену.
test('пояснение называет выбор модели, имя сервера у вызова и платность запуска', () => {
  const start = page.indexOf('<section class="about"')
  assert.notEqual(start, -1, 'блока пояснения на странице нет')
  const about = page.slice(start, page.indexOf('</section>', start))
  assert.ok(about.includes('сама модель'), 'пояснение не говорит, что выбирает модель')
  assert.ok(about.includes('имя сервера'), 'пояснение не говорит, чем видна маршрутизация')
  assert.ok(about.includes('стоит денег'), 'пояснение не говорит, что запуск платный')
})

// Поле ввода оформляет style.css — а оформляет он ПО ID (#cmd). Поле с другим
// id проходит мимо всех правил и получает браузерное умолчание: нулевой радиус,
// чужой шрифт, высота вдвое меньше кнопки рядом. Ни один тест этого не ловил,
// и дефект так и доехал до ревью. Проверка связывает три места, где id один.
test('текстовое поле носит id, который оформляет style.css, и его же ищет app.js', () => {
  const m = page.match(/<input id="([^"]+)" type="text"/)
  assert.ok(m, 'текстового поля на странице нет')
  const id = m[1]
  assert.match(read('style.css'), new RegExp(`#${id}\\s*\\{`), `style.css не оформляет #${id}`)
  assert.ok(stripJs(read('app.js')).includes(`byId('${id}')`), `app.js не ищет #${id}`)
})

// Цену запуска экран обязан назвать ДО кнопки. Когда блок пояснения стоял ниже
// формы, на 390 px строка «модель участвует, и запуск стоит денег» оказывалась
// на 443 px ниже кнопки — за первым экраном, и «Запустить» предлагалось без
// цены. Порядок в разметке и есть порядок на экране: колонка одна, ни order,
// ни grid-перестановок в правилах страницы нет.
test('пояснение с ценой запуска стоит выше формы запуска', () => {
  const about = page.indexOf('<section class="about"')
  const form = page.indexOf('<form class="composer"')
  assert.notEqual(about, -1, 'блока пояснения на странице нет')
  assert.notEqual(form, -1, 'формы запуска на странице нет')
  assert.ok(about < form, 'блок пояснения стоит ниже кнопки «Запустить»')
})

// Слова модели — проза, а не тело протокола (ADR 2026-09-28-1852, заход 1).
// style.css править нельзя (style-copy.test.js держит его побайтово), поэтому
// полосу чтения корпуса ставит <style> самой страницы. Проверка идёт ОТ МЕСТА,
// куда кладётся текст модели, а не от имени класса в CSS: переименуют класс —
// покраснеет, а не позеленеет молча.
test('текст модели ограничен полосой чтения корпуса и сохраняет переносы строк', () => {
  const m = code.match(/node\('p', `(\w+)\$\{[^`]*`, wordsText\(/)
  assert.ok(m, 'текст модели кладётся не тем узлом, что ожидает проверка')
  const style = page.slice(page.indexOf('<style>'), page.indexOf('</style>'))
  assert.match(style, new RegExp(`\\.${m[1]}\\s*\\{[^}]*max-width:68ch`), `у .${m[1]} нет полосы чтения`)
  assert.match(style, new RegExp(`\\.${m[1]}\\s*\\{[^}]*white-space:pre-wrap`), `у .${m[1]} съедаются переносы строк`)
})

// Запись со словами уходит в ленту БЕЗ условия на непустой текст: круг, на
// котором модель промолчала, виден так же, как круг со словами. Условие тут
// было бы прямым нарушением требования ADR, и проверка стоит на его месте.
test('событие со словами модели не фильтруется по непустому тексту', () => {
  const branch = code.slice(code.indexOf("stage === 'llm_text'"), code.indexOf('if (event?.stage !== ', code.indexOf("stage === 'llm_text'")))
  assert.ok(branch.includes('parseWords(event.data)'), 'ветка разбора слов не найдена')
  assert.doesNotMatch(branch, /\.text/, `в ветке появилось условие на текст: ${branch}`)
  const push = branch.indexOf('items.push')
  const quit = branch.indexOf('return')
  assert.ok(push !== -1 && (quit === -1 || push < quit), 'ветка выходит раньше, чем кладёт запись')
})
