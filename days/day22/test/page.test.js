// Запреты и обещания страницы — механически, по исходному тексту.
//
// ЧЕСТНО О МЕТОДЕ: проверки здесь СТРУКТУРНЫЕ. Поведение ими не доказывается —
// оно доказано исполнением в run.test.js, evalview.test.js и server.test.js.
// Здесь предмет сам текстовый: обращения к localStorage не должно быть,
// подстановки разметки строкой не должно быть, подпись у поля и aria-live
// должны быть, а порядок блоков в разметке и есть порядок на экране.
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
const full = read('index.html')
const page = stripHtml(full)
/** Свой блок правил страницы, без копии дня 16 (она в style.css). */
const own = page.slice(page.indexOf('<style>'), page.indexOf('</style>'))

test('снятие комментариев не съело код — иначе все запреты ниже зелены впустую', () => {
  assert.ok(scripts.length >= 4, `модулей страницы найдено ${scripts.length}`)
  assert.ok(code.includes('document.getElementById'), 'из app.js пропал код')
  assert.ok(code.includes('export function steps'), 'из run.js пропал код')
  assert.ok(code.includes('export function verdict'), 'из evalview.js пропал код')
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

test('позиция чтения принадлежит посетителю: автопрокрутки и угона фокуса нет', () => {
  for (const name of ['scrollIntoView', 'scrollTo(', 'scrollTop', '.focus()'])
    assert.ok(!code.includes(name), `${name} на странице`)
})

test('у каждого поля ввода есть подпись, связанная с ним', () => {
  const ids = [...page.matchAll(/<(?:input|textarea)[^>]*\bid="([^"]+)"/g)].map((m) => m[1])
  const labels = [...page.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map((m) => m[1])
  const wrapped = [...page.matchAll(/<label[^>]*>\s*<input[^>]*\bid="([^"]+)"/g)].map((m) => m[1])
  assert.ok(ids.includes('q'), 'поля вопроса на странице нет')
  for (const id of ids)
    assert.ok(labels.includes(id) || wrapped.includes(id), `у поля #${id} нет подписи`)
})

test('переключатель режима — настоящая радиогруппа с legend, а не div с role', () => {
  assert.match(page, /<fieldset class="modes">\s*<legend/)
  const radios = [...page.matchAll(/<input type="radio" name="mode" value="([a-z]+)"([^>]*)>/g)]
  assert.deepEqual(radios.map((m) => m[1]), ['rag', 'norag'], 'режимов ровно два, и порядок тот же')
  // Умолчание — режим с RAG: предмет дня, и экран открывается на нём.
  assert.match(radios[0][2], /checked/, 'умолчание не «с RAG»')
  assert.ok(!radios[1][2].includes('checked'))
  assert.ok(!page.includes('role="radiogroup"'), 'роль подменяет настоящий fieldset')
  assert.ok(!page.includes('aria-pressed'), 'чипы вместо выбора до действия')
})

test('живой регион на экране один, и это строка состояния', () => {
  const live = [...page.matchAll(/aria-live="/g)].length
  const statuses = [...page.matchAll(/role="status"/g)].length
  assert.equal(live, 1, `живых областей ${live}, а должна быть одна`)
  assert.equal(statuses, 1, `role="status" стоит ${statuses} раз`)
  assert.match(page, /<p class="cmd-status" id="status" role="status" aria-live="polite">/)
})

test('без JavaScript страница говорит об этом, а не молчит пустотой', () => {
  const noscript = page.slice(page.indexOf('<noscript>'), page.indexOf('</noscript>'))
  assert.match(noscript, /скриптом, а он отключён/)
  assert.match(noscript, /eval\.json/)
})

test('один h1, уровни не пропущены, и h2 ровно пять', () => {
  assert.equal([...page.matchAll(/<h1[\s>]/g)].length, 1)
  const h2 = [...page.matchAll(/<h2[^>]*>([^<]+)</g)].map((m) => m[1])
  assert.deepEqual(h2, ['Вопрос', 'Ответ', 'Источники', 'Как шёл конвейер', 'Итоги 10 контрольных вопросов'])
  assert.equal([...page.matchAll(/<h[3-6][\s>]/g)].length, 0, 'уровень пропущен')
})

// Порядок в разметке и есть порядок на экране: ни `order`, ни перестановок
// grid в правилах страницы нет — это проверяется здесь же, иначе блок мог бы
// стоять выше в разметке и ниже на экране.
test('порядок блоков — он же порядок чтения и порядок Tab', () => {
  const at = (needle) => {
    const i = page.indexOf(needle)
    assert.notEqual(i, -1, `на странице нет ${needle}`)
    return i
  }
  const order = [
    '<h1>',
    '<p class="sub">',
    '<p class="wire">',
    'id="ask-h"',
    'id="answer-h"',
    'id="srcs-h"',
    'id="steps-h"',
    'id="eval-h"',
    '<footer>',
  ].map(at)
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'порядок блоков разошёлся с порядком чтения')
  assert.ok(!/\border\s*:/.test(own), 'в правилах страницы есть order — порядок на экране не равен порядку разметки')
  assert.ok(!/grid-auto-flow|grid-row\s*:|grid-column\s*:/.test(own), 'перестановка grid меняет порядок на экране')
})

// Цену экран обязан назвать ДО кнопки, и переключатель режима — тоже: иначе
// выбор делается уже после нажатия (раскладка, пп. 2.3, 19.1).
test('строка цены и переключатель режима стоят выше кнопки «Спросить»', () => {
  const wire = page.indexOf('<p class="wire">')
  const modes = page.indexOf('<fieldset class="modes">')
  const button = page.indexOf('<button class="send"')
  assert.ok(wire !== -1 && modes !== -1 && button !== -1)
  assert.ok(wire < modes, 'цена ниже переключателя')
  assert.ok(modes < button, 'переключатель режима ниже кнопки')
  assert.match(page, /каждый вопрос — <b>платный<\/b> вызов модели/)
})

test('числа суточного предела в разметке нет: достоверное приходит от сервера', () => {
  const wire = page.slice(page.indexOf('<p class="wire">'), page.indexOf('</p>', page.indexOf('<p class="wire">')))
  assert.match(wire, /суточный предел вопросов — общий на всех посетителей/)
  // Любое число рядом с «предел» было бы второй копией значения окружения.
  assert.ok(!/предел[^<]*\d/.test(wire), `число предела в разметке: ${wire}`)
  assert.ok(!page.includes('MAX_DAILY_CALLS'), 'имя переменной окружения на странице')
})

test('числа итогов и состава набора литералом в разметке не стоят (критерий 10)', () => {
  const evalSection = page.slice(page.indexOf('id="eval-state"'), page.indexOf('<footer>'))
  // Срез начинается ПОСЛЕ заголовка, и это названо, а не обойдено молча: в
  // заголовке «Итоги 10 контрольных вопросов» число 10 — размер набора,
  // заданный решением дня (ADR, п. 5), а не итог прогона. Оно живёт по тому же
  // правилу, что «5 фрагментов» в строке цены (раскладка, п. 3.2): меняется
  // только правкой кода дня, а не молча вслед за файлом. ИТОГИ — всё, что
  // ниже, — литералов не несут вовсе.
  const numbers = evalSection.match(/\b\d+\b/g) ?? []
  assert.deepEqual(numbers, [], `числа в разметке итогов: ${numbers.join(', ')}`)
  // Если состав набора однажды разойдётся с заголовком, это увидит строка
  // границ метода: она считает вопросы по файлу и говорит своё число рядом.
  assert.ok(evalSection.includes('id="eval-limits"'), 'числа состава приходить неоткуда')
  // Границы метода — внутри секции и БЕЗ details: «насколько уверенно» — часть
  // ответа, а не примечание (п. 9.3).
  assert.ok(evalSection.includes('id="eval-limits"'))
  const limits = evalSection.indexOf('id="eval-limits"')
  const qs = evalSection.indexOf('id="qs"')
  assert.ok(limits < qs, 'границы метода стоят ниже списка вопросов')
  assert.ok(!evalSection.slice(0, limits).includes('<details'), 'границы метода спрятаны под раскрытие')
})

test('ключей и секретов в клиентском коде нет (I-1)', () => {
  for (const name of ['AGENT_KEY', 'RAG_KEY', 'MCP_KEY', 'ANTHROPIC_API_KEY', 'Bearer', 'authorization', 'Authorization'])
    assert.ok(!code.includes(name), `${name} в клиентском коде`)
  for (const name of ['AGENT_KEY', 'RAG_KEY', 'Authorization'])
    assert.ok(!page.includes(name), `${name} в разметке`)
})

// Адрес службы поиска на экране не показывается: на экран идёт ТЕЛО JSON-RPC,
// а не HTTP-запрос (раскладка, п. 7.2, критерий 27). Имени переменной адреса и
// внутреннего имени контейнера в клиентском коде быть не должно.
test('адреса службы поиска и её заголовков на странице нет (критерий 27)', () => {
  for (const name of ['MCP_RAG_URL', 'rag:8086', '/rag', 'Authorization', 'authorization'])
    assert.ok(!code.includes(name), `${name} в клиентском коде`)
  assert.ok(code.includes("'ЗАПРОС'") && code.includes("'ОТВЕТ'"), 'тел протокола на экране нет вовсе')
})

test('свёртки свёрнуты по умолчанию, и «раскрыть все» нет', () => {
  // `open` ставится только разметкой или кодом; ни того, ни другого быть не
  // должно: страница ничего не раскрывает сама (п. 2.3).
  assert.ok(!page.includes('<details open'), 'свёртка раскрыта разметкой')
  assert.ok(!/\.open\s*=/.test(code), 'свёртку раскрывает код')
  assert.ok(!/toggleAttribute\(['"]open/.test(code))
  assert.ok(!code.includes('раскрыть все'))
})

test('размеров шрифта на экране четыре, и пятого в правилах страницы нет', () => {
  const sizes = new Set([...own.matchAll(/var\(--t-([a-z0-9]+)\)/g)].map((m) => m[1]))
  for (const size of sizes) assert.ok(['xs', 'sm', 'md', 'xl'].includes(size), `пятый размер --t-${size}`)
})

test('акцентный элемент один, --attn нет, --danger — только в двух местах', () => {
  // Акцент даёт правило `.send` копии; своих акцентных поверхностей страница
  // не заводит. `accent-color` красит галочку контрола и акцентным элементом
  // его не делает — прецедент `.indent` дня 16 (п. 4.2).
  const accents = [...own.matchAll(/background:\s*var\(--acc\)/g)].length
  assert.equal(accents, 0, 'страница заводит второй акцентный элемент')
  assert.ok(!own.includes('--attn'), 'жёлтый в правилах страницы')
  assert.ok(!own.includes('--danger'), 'свой --danger: он живёт правилами копии (.cmd-status.is-bad и fail)')
  // Оба места с --danger в коде названы: строка состояния и «ответа не было».
  assert.ok(code.includes("'is-bad'"), 'строка состояния не краснеет')
  assert.ok(code.includes("dataset.kind = 'fail'"), 'обрыв вызова не краснеет')
})

test('значений вне шкал нет, кроме рамок, порога медиазапроса и приёма скрытия', () => {
  // Числа с единицами в правилах страницы: каждое обязано быть либо шириной
  // рамки, либо порогом медиазапроса, либо колонкой сетки в rem, либо частью
  // приёма визуального скрытия, либо длительностью перехода.
  const allowed = new Set([
    '1px', '2px', // ширины рамок и кольца фокуса
    '48rem', '47.99rem', // единственный порог медиазапроса
    '120ms', // переход корпуса
    '68ch', '52ch', // полосы чтения корпуса
    '2rem', '3rem', '5rem', '7rem', '10rem', // колонки сеток пп. 2.2, 6.3, 9.4
    '50%', // clip-path приёма скрытия
    '100%', // ширина поля в своём ряду: не длина раскладки и места в шкале не занимает
    '1.4', '1.5', '1.6', '.06em', '.15em', // типографика корпуса
  ])
  const literals = [...own.matchAll(/(?<![\w-])(\d*\.?\d+(?:px|rem|em|ch|ms|s|%))/g)].map((m) => m[1])
  const bad = [...new Set(literals)].filter((v) => !allowed.has(v))
  assert.deepEqual(bad, [], `значения вне шкал: ${bad.join(', ')}`)
})

test('поле вопроса оформлено страницей со всеми пятью состояниями', () => {
  // Правила `#cmd` копии до `#q` не достают — селектор копии по
  // идентификатору. Поэтому состояния обязаны быть здесь, иначе поле получит
  // браузерное умолчание (дефект дня 20).
  const m = page.match(/<textarea id="([^"]+)"/)
  assert.ok(m, 'текстового поля на странице нет')
  const id = m[1]
  for (const state of ['', ':hover', ':active', '[disabled]:hover'])
    assert.match(own, new RegExp(`#${id}${state.replace(/[[\]]/g, '\\$&')}[^{]*\\{`), `у #${id} нет состояния ${state || 'покоя'}`)
  // Кольцо фокуса — общее правило копии `:focus-visible`, и своего у поля не нужно.
  assert.match(read('style.css'), /:focus-visible \{ outline:2px solid var\(--acc\)/)
  assert.ok(stripJs(read('app.js')).includes(`byId('${id}')`), `app.js не ищет #${id}`)
})

test('пока запуск идёт, поле, радиокнопки и кнопка запираются АТРИБУТОМ', () => {
  const app = stripJs(read('app.js'))
  assert.match(app, /input\.disabled = on/)
  assert.match(app, /send\.disabled = on/)
  assert.match(app, /radio\.disabled = on/, 'радиокнопки остаются живыми во время запуска')
})

test('тела протокола подписаны и достижимы с клавиатуры (п. 11)', () => {
  const app = stripJs(read('app.js'))
  assert.ok(app.includes('aria-labelledby'), 'рамка тела не подписана')
  assert.ok(app.includes('box.tabIndex = 0'), 'в рамку с прокруткой не попасть с клавиатуры')
  assert.match(read('style.css'), /\.rpc:focus-visible \{ outline-offset:-2px/)
})

test('на экране есть место, где назван отказ модели как результат (п. 5.3)', () => {
  const app = stripJs(read('app.js'))
  assert.ok(app.includes('REFUSED_NOTE'), 'строка-пояснение к отказу не показывается')
  assert.ok(app.includes('result.refused'), 'признак отказа не читается')
  // Отказ не красится: класса --danger у него нет, он идёт обычной записью.
  assert.ok(!/refused[^\n]*is-bad/.test(app))
})

test('подвал говорит про отсутствие хранения, общее окно службы и прогон', () => {
  const footer = page.slice(page.indexOf('<footer>'), page.indexOf('</footer>'))
  assert.match(footer, /сессий, cookie и переписки у этого дня нет/)
  assert.match(footer, /Окно службы одно на всех посетителей этого дня/)
  assert.match(footer, /прогон через этот же публичный адрес/)
  // Адреса посетителя на странице нет нигде (I-10).
  assert.ok(!page.includes('X-Forwarded-For') && !code.includes('X-Forwarded-For'))
})

test('сторонних запросов у страницы нет: ни шрифта, ни значка, ни скрипта', () => {
  const links = [...full.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1])
  for (const url of links) {
    if (url.startsWith('mailto:')) continue
    if (url.startsWith('https://github.com/MikeKharr/ai-advent-2026/')) continue
    assert.ok(!/^(?:https?:)?\/\//.test(url), `сторонний запрос со страницы: ${url}`)
  }
  // Ссылки в подвале — на репозиторий; они открываются по нажатию, а не
  // загружаются страницей. Загружаемых ресурсов должно быть ровно два.
  const loaded = [...full.matchAll(/<(?:link|script)[^>]*(?:href|src)="([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual(loaded, ['style.css', 'app.js'])
})
