// Запреты раскладки (2026-09-23-1242, п. 13) и шкалы корпуса — механически.
//
// ЧЕСТНО О МЕТОДЕ: это проверки СТРУКТУРНЫЕ — они читают исходный текст
// страницы. Поведение ими не доказывается, и там, где предмет поведенческий
// (разбор команды, пояснения, форматы), он проверен исполнением в
// console.test.js. Здесь предмет — сам текст: жёлтого цвета в нём быть не
// должно, обращения к localStorage не должно быть, размеров шрифта вне шкалы
// не должно быть. Такой предмет текстом и проверяется.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const read = (name) => readFileSync(join(here, '..', 'public', name), 'utf8')
/**
 * Комментарии снимаются ДО проверок. Иначе предмет подменяется: строка
 * «localStorage здесь нет» в комментарии — это отсутствие хранения, а
 * проверка по сырому тексту прочла бы её как присутствие и покраснела бы на
 * верном коде. Снятие проверяется само: после него в коде обязан остаться
 * работающий маркер (тест ниже).
 */
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
const stripHtml = (source) =>
  source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

const page = stripHtml(read('index.html'))
const app = stripJs(read('app.js'))
const logic = stripJs(read('console.js'))

const styleBlock = page.slice(page.indexOf('<style>'), page.indexOf('</style>'))
const css = styleBlock
/** Объявления CSS: свойство → список значений по всей таблице. */
const decls = [...css.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)/g)].map((m) => ({
  prop: m[1],
  value: m[2].trim(),
}))
const valuesOf = (prop) => decls.filter((d) => d.prop === prop).map((d) => d.value)

/** Палитра корпуса, обе темы. Ничего сверх неё на экране быть не может. */
const CORPUS_COLORS = new Set(
  [
    '#fbfbfa', '#ffffff', '#17171a', '#6a6a70', '#e6e6e3', '#8f8f8a', '#2f6f4f', '#b3261e',
    '#131316', '#1b1b1f', '#ececee', '#9b9ba3', '#2a2a30', '#6a6a73', '#6fc79c', '#0e1a13', '#f2b8b5',
  ].map((c) => c.toLowerCase()),
)


test('снятие комментариев не съело код — иначе все запреты ниже зелены впустую', () => {
  assert.ok(app.includes("document.getElementById"), 'из app.js пропал код')
  assert.ok(logic.includes('export function parseCommand'), 'из console.js пропал код')
  assert.ok(page.includes('<h1>Консоль MCP</h1>'), 'из разметки пропал заголовок')
  assert.ok(css.includes('--acc:#2f6f4f'), 'из таблицы стилей пропали токены')
  // А комментарии — съело: в них запреты названы словами.
  assert.equal(app.includes('scrollIntoView'), false)
  assert.equal(read('app.js').includes('scrollIntoView'), true, 'в исходнике слово есть — значит, сняли именно комментарий')
})

test('цвета — только корпусные; жёлтого и токена --attn на экране нет', () => {
  const hexes = [...css.matchAll(/#[0-9a-fA-F]{3,8}/g)].map((m) => m[0].toLowerCase())
  assert.ok(hexes.length > 0, 'цветов не найдено — значит, ищем не там')
  for (const hex of hexes) assert.ok(CORPUS_COLORS.has(hex), `цвет вне корпуса: ${hex}`)
  assert.equal(/--attn/.test(page), false, 'день 16 в именное исключение корпуса не входит')
  // Жёлтый мог бы приехать и не хексом.
  for (const word of ['yellow', 'gold', 'orange', 'amber'])
    assert.equal(new RegExp(word, 'i').test(css), false, `жёлтый словом: ${word}`)
  assert.equal(/--overlay/.test(page), false, 'модальных окон на экране нет — подложка не нужна')
})

test('размеров шрифта на экране четыре, и все из шкалы --t-*', () => {
  const used = new Set()
  for (const value of valuesOf('font-size')) {
    if (value === 'inherit') continue
    const token = value.match(/^var\((--t-[a-z0-9]+)\)$/)
    assert.ok(token, `размер шрифта вне шкалы: ${value}`)
    used.add(token[1])
  }
  assert.deepEqual([...used].sort(), ['--t-md', '--t-sm', '--t-xl', '--t-xs'])
})

test('отступы и радиусы — только из шкал --s-* и --r-*', () => {
  const spacing = ['padding', 'margin', 'gap', 'row-gap', 'column-gap', 'padding-top', 'margin-top', 'margin-left']
  for (const prop of spacing)
    for (const value of valuesOf(prop))
      for (const part of value.split(/\s+/))
        assert.ok(
          /^var\(--s-[1-8]\)$/.test(part) || part === '0' || part === 'auto',
          `${prop}: ${value} — значение ${part} вне шкалы --s-*`,
        )
  for (const value of valuesOf('border-radius'))
    assert.match(value, /^var\(--r-(sm|md|full)\)$/, `радиус вне шкалы: ${value}`)
})

test('акцентный элемент один — «Отправить»', () => {
  const accentRules = [...css.matchAll(/([^{}]+)\{([^{}]*background:var\(--acc\)[^{}]*)\}/g)].map((m) =>
    m[1].trim(),
  )
  assert.deepEqual(accentRules, ['.send'], 'второй акцент в кадре — дефект раскладки, п. 13.4')
})

test('--danger стоит ровно там, где раскладка его разрешила', () => {
  const dangerRules = [...css.matchAll(/([^{}]+)\{([^{}]*var\(--danger\)[^{}]*)\}/g)].map((m) => m[1].trim())
  assert.deepEqual(
    dangerRules.sort(),
    ['.cmd-status.is-bad', '.entry[data-kind="fail"] .entry-note'].sort(),
    'красный — только «ответ не получен» (п. 8.1) и «Не отправлено» в строке состояния (п. 6.3)',
  )
  // 401, 405 и 429 красными не бывают: у них своя нейтральная ветка.
  assert.equal(/data-kind="proto"[^{}]*\{[^{}]*--danger/.test(css), false)
})

test('история не сохраняется нигде', () => {
  for (const source of [page, app, logic])
    for (const store of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie'])
      assert.equal(source.includes(store), false, `на странице есть ${store}`)
  // И сказано об этом дважды: в пустом состоянии и в подвале (п. 5.3).
  const said = page.match(/История живёт до перезагрузки страницы/g) ?? []
  assert.equal(said.length, 1)
  assert.match(page, /история живёт до\s*\n?\s*перезагрузки страницы/)
})

test('автопрокрутки и угона фокуса на новую запись нет', () => {
  for (const banned of ['scrollIntoView', 'scrollTop', 'scrollTo('])
    assert.equal(app.includes(banned), false, `прокрутка страницы принадлежит посетителю: ${banned}`)
  // Фокус после отправки остаётся в поле ввода и на запись не уходит.
  assert.equal(/\.el\.focus\(\)|entry.*\.focus\(\)/.test(app), false)
})

test('подсветки синтаксиса нет: в тело кладётся текст, а не разметка', () => {
  for (const banned of ['innerHTML', 'insertAdjacentHTML', 'outerHTML'])
    assert.equal(app.includes(banned), false, `разметка в теле ответа — это подсветка: ${banned}`)
  assert.equal(/\.rpc\s+(span|code|em|b)\b/.test(css), false, 'внутри .rpc нет вложенных элементов с цветом')
})

test('сторонних запросов со страницы нет ни одного', () => {
  const urls = [...page.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])
  for (const url of urls)
    assert.ok(
      url.startsWith('mailto:') || !/^(https?:)?\/\//.test(url),
      `сторонний запрос со страницы: ${url}`,
    )
  assert.equal(/@import|fonts\.googleapis|cdn\./.test(page), false)
})

test('заголовки, живой регион и подписи списков — по разметке доступности', () => {
  assert.equal((page.match(/<h1[ >]/g) ?? []).length, 1)
  assert.equal((page.match(/<h2[ >]/g) ?? []).length, 3, 'Готовые команды, Пробы протокола, Лента команд')
  assert.equal((page.match(/<h3[ >]/g) ?? []).length, 0, 'уровни не пропускаются')
  assert.equal((page.match(/aria-live=/g) ?? []).length, 1, 'двух живых регионов на экране быть не должно')
  assert.equal((page.match(/role="status"/g) ?? []).length, 1)
  assert.equal((page.match(/<ul class="chips" aria-labelledby=/g) ?? []).length, 2)
  assert.match(page, /<label class="field" for="cmd">/)
  assert.match(page, /<noscript>/, 'без JS страница обязана сказать об этом, а не молчать')
})

test('поле ввода не даёт мобильной клавиатуре испортить JSON', () => {
  const field = page.match(/<input id="cmd"[^>]*>/)[0]
  for (const attr of ['spellcheck="false"', 'autocapitalize="off"', 'autocorrect="off"', 'maxlength="600"'])
    assert.ok(field.includes(attr), `у поля нет ${attr}: ${field}`)
  assert.ok(field.includes('type="text"'), 'однострочное поле: Enter отправляет нативно')
})

test('движение — только на смену состояния, ≤120 мс, и снимается полностью', () => {
  for (const value of valuesOf('transition')) {
    if (value === 'none !important') continue
    const ms = Number(value.match(/(\d+)ms/)?.[1])
    assert.ok(ms > 0 && ms <= 120, `переход ${value} длиннее 120 мс`)
  }
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \* \{ transition:none !important; \} \}/)
  assert.equal(/@keyframes|animation:/.test(css), false, 'появление записи не анимируется')
})

test('прокрутка тела — вертикальная и своя; горизонтальной нет ни на одной ширине', () => {
  const rpc = css.match(/\.rpc \{[^}]*\}/)[0]
  assert.match(rpc, /white-space:pre-wrap/)
  assert.match(rpc, /overflow-wrap:anywhere/)
  assert.match(rpc, /max-height:calc\(8 \* var\(--s-6\)\)/, 'потолок 256 px')
  assert.match(css, /\.rpc\.is-req \{ max-height:calc\(4 \* var\(--s-6\)\); \}/, 'запрос — 128 px')
  assert.match(css, /\.chip \{[^}]*overflow-wrap:anywhere/, 'длинная подпись переносится внутри кнопки')
})

test('ключа нет ни в разметке, ни в коде страницы (I-1)', () => {
  for (const source of [page, app, logic])
    for (const word of ['MCP_KEY', 'Bearer', 'authorization', 'Authorization'])
      assert.equal(source.includes(word), false, `страница знает про ключ: ${word}`)
  // Страница просит «не подставляй ключ», а не «дай ключ».
  assert.match(app, /noKey: parsed\.noKey/)
})

test('готовая команда вставляет текст в поле и НЕ отправляет его', () => {
  // Проверка СТРУКТУРНАЯ и это её предел: обработчик — DOM, а зависимостей
  // (jsdom) у дня нет и быть не может (ADR 2026-09-07-1525). Поведением
  // критерий 1 раскладки проверен живьём в браузере, запись — в README дня.
  const handler = app.match(/for \(const chip of document\.querySelectorAll\('\.chip'\)\) \{[\s\S]*?\n\s*\}\)\n\}/)
  assert.ok(handler, 'обработчик готовых команд не найден — его переименовали или убрали')
  const code = handler[0]
  // Конец строки в шаблоне обязателен: без него «…trim().split(' ')[0]»
  // содержит искомое как подстроку, и проверка зеленеет на урезанной команде.
  assert.match(code, /input\.value = chip\.textContent\.trim\(\)\n/, 'в поле встаёт подпись кнопки целиком')
  assert.equal(/submit\(/.test(code), false, 'нажатие на готовую команду ничего не отправляет (п. 13.7)')
  assert.match(code, /input\.focus\(\)/, 'фокус переходит в поле')
  assert.match(code, /setSelectionRange\(input\.value\.length, input\.value\.length\)/, 'курсор в конце')
})
