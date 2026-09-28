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

// Справка о работе — предмет текстовый, и проверка ему под стать: нужно, чтобы
// экран называл, ЧЕМ работа делается, а не «агент собирает новости». Проверка
// именами шагов, а не длиной абзаца: абзац можно налить водой.
test('справка называет цепочку, её шаги, сверку и источник', () => {
  const start = page.indexOf('<section class="about"')
  assert.notEqual(start, -1, 'блока справки на странице нет')
  const about = page.slice(start, page.indexOf('</section>', start))
  for (const word of ['pipeline-agent', 'news.search', 'news.summarize', 'file.save', 'file.read', 'sha256', 'Hacker News'])
    assert.ok(about.includes(word), `справка не называет ${word}`)
  // И почему бывает пусто — иначе пустой экран читается как поломка.
  assert.ok(about.includes('пуст'), 'справка не объясняет пустой экран')
})

// Запрос обязан быть НА СТРАНИЦЕ, а не только в ответе ручки: владелец просил
// видеть его на экране. Предмет текстовый — место под текст и объяснение рядом.
test('на экране есть место под текст запроса и сказано, откуда он берётся', () => {
  const start = page.indexOf('<section class="about"')
  const about = page.slice(start, page.indexOf('</section>', start))
  assert.ok(about.includes('id="f-prompt"'), 'места под текст запроса на экране нет')
  assert.ok(about.includes('файле настроек'), 'не сказано, откуда запрос берётся')
  // И это место заполняется тем, что назвало неизвестное словом, а не сырым полем.
  assert.ok(code.includes("byId('f-prompt').textContent = promptLine("), 'запрос кладётся мимо promptLine')
})

// Полоса чтения. В .entry-note кладётся текст сводки — проза, а не одна строка,
// как было в дне 16, и правило копии ширину ей не задаёт: на 1024 px строка
// уходила за 100 знаков при корпусном пороге 68. style.css править нельзя
// (style-copy.test.js держит его побайтово), границу ставит <style> страницы.
// Проверка идёт ОТ МЕСТА, куда кладётся сводка, а не от имени класса в CSS.
test('текст сводки ограничен полосой чтения корпуса', () => {
  const m = code.match(/node\('p', '([^']+)', run\.summary/)
  assert.ok(m, 'сводка кладётся не тем узлом, что ожидает проверка')
  const style = page.slice(page.indexOf('<style>'), page.indexOf('</style>'))
  assert.match(style, new RegExp(`\\.${m[1]}\\s*\\{[^}]*max-width:68ch`), `у .${m[1]} нет полосы чтения`)
})

// Держатель невмешательства дня 20 в день 18 (ADR 2026-09-28-1852, заход 1).
// Цикл `runToolLoop` общий у планировщика и дня 20, и со дня 20 в поток
// событий пошла стадия `llm_text` — слова модели. Лента планировщика их не
// показывает и показывать не должна: её предмет — протокол, а не текст, и
// стоимость ночной сводки от слов не зависит. Проверка идёт от РАЗБОРА
// СОБЫТИЙ в коде страницы, а не от отсутствия слова в файле: она собирает все
// стадии, с которыми страница себя сравнивает, и требует, чтобы других, кроме
// `rpc`, не появилось. Пустой находки тут быть не может — первая строка
// требует, чтобы сравнение нашлось хотя бы одно.
test('лента планировщика разбирает только стадию rpc: слова модели дня 20 в неё не попадают', () => {
  const stages = [...code.matchAll(/stage\s*[!=]==\s*'([^']*)'/g)].map((m) => m[1])
  assert.ok(stages.length > 0, 'сравнения со стадией в коде страницы не нашлось — проверка ничего не держит')
  assert.deepEqual([...new Set(stages)], ['rpc'], `страница разбирает не только rpc: ${stages.join(', ')}`)
})
