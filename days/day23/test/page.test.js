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
/**
 * Свой блок правил страницы, без копии дня 16 (она в style.css) и БЕЗ
 * комментариев.
 *
 * Снятие комментариев здесь обязательно по той же причине, что и в скриптах:
 * в них правила названы словами — «не `--danger`», «PR #303», — и проверка по
 * сырому тексту прочла бы их как объявление цвета и как шестнадцатеричный
 * литерал, то есть покраснела бы на верном коде. Само снятие проверяется
 * тестом ниже.
 */
function stripCss(source) {
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
    if (c === '"' || c === "'") { quote = c; out += c; i += 1; continue }
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? source.length : end + 2
      continue
    }
    out += c
    i += 1
  }
  return out
}
const ownRaw = page.slice(page.indexOf('<style>'), page.indexOf('</style>'))
const own = stripCss(ownRaw)

/**
 * Снятие комментариев само — под прогоном, а не под честным словом.
 *
 * Прежняя редакция снимала их одним выражением и про строки не знала: `/*`
 * внутри строкового ЗНАЧЕНИЯ открывал ей комментарий, и всё до ближайшего
 * настоящего закрытия — вместе с настоящими правилами и значениями мимо
 * корпуса — исчезало из `own`, то есть из предмета ВСЕХ проверок корпуса
 * ниже. Проба `reviewer` к PR #303 показала, что на такой подмене набор
 * оставался зелёным, а утверждение про хвост блока её не ловило: инъекция
 * закрывается ближайшим следующим комментарием, а их в блоке много, и до
 * конца блока дело не доходит никогда.
 *
 * Поэтому снятие проверяется ИСПОЛНЕНИЕМ на образце, который содержит ровно
 * этот случай. Возврат к выражению красит этот тест.
 */
test('снятие комментариев знает про строки: /* в значении не открывает комментарий', () => {
  const sample = [
    '.a { content:"/*"; font-size:13px; }',
    '/* настоящий комментарий */',
    '.b { color:red; }',
    ".c { content:'/*'; }",
    '.z { outline:none; }',
  ].join('\n')
  const stripped = stripCss(sample)
  // Настоящий комментарий — снят.
  assert.equal(stripped.includes('настоящий комментарий'), false, 'комментарий не снят')
  // Всё остальное — на месте: и значение мимо корпуса в правиле с `/*` внутри
  // строки, и правила ПОСЛЕ него, и хвост.
  assert.ok(stripped.includes('font-size:13px'), 'значение мимо корпуса съедено вместе с инъекцией')
  assert.ok(stripped.includes('.b { color:red; }'), 'правило после инъекции съедено')
  assert.ok(stripped.includes('.z { outline:none; }'), 'хвост образца съеден')
})

test('снятие комментариев в блоке правил не съело сами правила', () => {
  assert.ok(own.includes('.src-grid'), 'из блока правил пропал CSS')
  assert.ok(own.includes('grid-template-columns'), 'из блока правил пропал CSS')
  // ПОСЛЕДНЕЕ правило блока — отдельно: проверка раннего правила не заметила
  // бы, что снятие съело хвост.
  assert.ok(own.includes('prefers-reduced-motion'), 'снятие комментариев съело хвост блока правил')
  // А комментарии — съело: в них правила названы словами.
  assert.equal(own.includes('--danger'), false)
  assert.equal(ownRaw.includes('--danger'), true, 'в исходнике слово есть — значит, сняли именно комментарий')
})

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

test('позиция чтения принадлежит посетителю: автопрокрутки нет', () => {
  for (const name of ['scrollIntoView', 'scrollTo(', 'scrollTop'])
    assert.ok(!code.includes(name), `${name} на странице`)
})

/**
 * Фокус ВОЗВРАЩАЕТСЯ тому, у кого его забрало запирание, и только ему.
 *
 * Критерий 21 требует, чтобы после отправки фокус был в поле, а п. 13.6 —
 * чтобы угона фокуса не было: это одно и то же требование с двух сторон, и
 * безусловный `input.focus()` нарушал бы вторую половину. Поэтому проверяется
 * не отсутствие `focus()`, а наличие ОБОИХ условий вокруг него.
 *
 * Находка `design-review` к PR #303: прежняя редакция не возвращала фокус
 * вовсе, и после отправки `activeElement` оставался `body`.
 */
test('фокус возвращается в поле только из body и только если его там забрали', () => {
  const app = stripJs(read('app.js'))
  const calls = [...app.matchAll(/\.focus\(\)/g)]
  assert.equal(calls.length, 1, `вызовов focus() ${calls.length}, а должен быть один`)
  // Условие «фокус до сих пор там, куда его уронило запирание».
  assert.match(app, /document\.activeElement === document\.body\) input\.focus\(\)/)
  // Условие «забрали именно у него»: флаг считается при запирании…
  assert.match(app, /if \(on\) refocus = document\.activeElement === input \|\| document\.activeElement === send/)
  // …и гасится, когда посетитель ушёл сам, пока запуск идёт.
  assert.match(app, /focusin/)
  assert.match(app, /refocus = false/)
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
  assert.deepEqual(
    radios.map((m) => m[1]),
    ['rag', 'rerank', 'rewrite'],
    'режимов ровно три, и порядок тот же: без отбора, с отбором, с переписыванием',
  )
  // Умолчание — режим без отбора: это «до», с которым сравнивают остальные два.
  assert.match(radios[0][2], /checked/, 'умолчание не «без отбора»')
  assert.ok(!radios[1][2].includes('checked'))
  assert.ok(!radios[2][2].includes('checked'))
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

test('один h1, уровни не пропущены, и h2 ровно шесть', () => {
  assert.equal([...page.matchAll(/<h1[\s>]/g)].length, 1)
  const h2 = [...page.matchAll(/<h2[^>]*>([^<]+)</g)].map((m) => m[1])
  // «Отбор» стоит ВЫШЕ источников: источники — его результат, а не наоборот.
  assert.deepEqual(h2, [
    'Вопрос',
    'Ответ',
    'Отбор',
    'Источники',
    'Как шёл конвейер',
    'Итоги прогона: до отбора и после',
  ])
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
  assert.match(page, /каждый вопрос — от <b>одного<\/b> до <b>трёх<\/b> платных вызовов модели/)
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

// ДОЛГ ДНЯ 22, ЗАКРЫВАЕМЫЙ ЗДЕСЬ (развилка Р8 ADR 2026-10-05-0544; пункт
// «Владельцу» в agent_docs/backlog.md): честное «не знаю» и выдумка попадали
// в дне 22 в один вердикт 0, а имена механик `cited` и `refused` обещали не
// то, что считали.
//
// Комментарии снимаются намеренно: запрещённые слова названы в них как
// запрещённые, и проверка по сырому тексту покраснела бы на верном коде.
test('пустой отбор назван исходом, а не промахом и не выдумкой', () => {
  const INVENTED = /выдум/i
  assert.ok(!INVENTED.test(code), `«выдум» в коде страницы: ${code.match(INVENTED)?.[0]}`)
  assert.ok(!INVENTED.test(page), '«выдум» в разметке страницы')

  // Механики `cited` на этом дне нет вовсе: она искала путь эталона
  // ПОДСТРОКОЙ в тексте ответа и ошибалась в обе стороны. Ищется само имя —
  // чтобы она не вернулась копированием.
  const run = stripJs(read('run.js'))
  const view = stripJs(read('evalview.js'))
  for (const file of [code, view, run])
    assert.ok(!/\bcited\b/.test(file), 'механика cited вернулась в день 23')

  // Исход «отбор ничего не оставил» назван СВОИМИ СЛОВАМИ и показан в двух
  // секциях: там, где решение принято («Отбор»), и там, где виден его
  // результат («Источники»). Без второго места секция источников сказала бы
  // «Поиск отказал» — ту самую неправду, из-за которой честный отказ дня 22
  // читался как сбой.
  assert.ok(run.includes('export function selectNone'), 'исхода пустого отбора нет в правилах показа')
  // Показан он в ТРЁХ местах: блок ответа (там, где иначе встало бы «модель
  // вернула пустой ответ»), секция «Отбор» (там принято решение) и секция
  // «Источники» (там виден результат). Меньше трёх — какое-то из мест снова
  // скажет про сбой или про вызов, которого не было.
  const uses = [...code.matchAll(/selectNone\(/g)].length
  assert.ok(uses >= 3, `исход пустого отбора показан ${uses} раз, а мест для него три`)
  // Исход берётся ПОЛЕМ, а не выводится из косвенных признаков: модель ответа
  // при нём не вызывалась, и утверждать это за агента страница не вправе.
  assert.match(code, /outcome === 'unknown_filter'/, 'исход снова выводится, а не читается')
  assert.match(
    code,
    /isUnknownFilter\(result\) \? selectNone\(result\.candidates\.length\) : SRCS_FAILED/,
    'пустой отбор снова неотличим от отказа поиска',
  )
})

// Маркер раскрытия и полоса чтения — обе находки `design-review` к PR #304.
// Держателя у них до неё не было: раскладка проверяется на живой странице, а
// ревью — не CI, и снятие знака прошло бы молча.
test('у каждой свёртки есть знак раскрытия, а у фразы вывода — полоса чтения', () => {
  const app = stripJs(read('app.js'))
  // Счёт, а не наличие: свёрток на странице три (протокол вызова, текст
  // фрагмента, строка вопроса), и знак обязан быть у каждой. Наличие хотя бы
  // одного `.mark` было зелено и при снятом знаке у строки вопроса — это и
  // случилось в PR 3.
  const summaries = [...app.matchAll(/node\('summary'\)/g)].length
  const marks = [...app.matchAll(/node\('span', 'mark'\)/g)].length
  // Четвёртая свёртка дня 23 — выдержка кандидата, та самая, что видел
  // реранкер.
  assert.equal(summaries, 4, 'свёрток на странице не четыре — проверено не то')
  assert.equal(marks, summaries, `свёрток ${summaries}, знаков раскрытия ${marks}`)
  // Знак — не содержание строки: состояние сообщает сам `details`.
  assert.equal([...app.matchAll(/mark\.setAttribute\('aria-hidden', 'true'\)/g)].length, marks)
  // Своя колонка у маркера строки вопроса: сетка сводки — пять колонок, пятая
  // под знак. Без неё знак встал бы поверх вердикта.
  assert.match(own, /\.q > summary \{[\s\S]*?grid-template-columns:3rem minmax\(0,1fr\) 7rem 7rem 2rem/)
  // Полоса заголовков считает колонки по той же сетке: без пятой колонки
  // вердикты разъезжаются с заголовками на ширину знака.
  assert.match(own, /\.colhead \{[\s\S]*?grid-template-columns:3rem minmax\(0,1fr\) 7rem 7rem 2rem/)

  // Проза ≤ 68ch (корпус). Класс `wrap` полосой не является — это `min-width:0`.
  assert.match(own, /#sum-verdict \{[^}]*max-width:68ch/, 'у фразы вывода нет полосы чтения')
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

/**
 * Запертые контролы не отвечают мыши.
 *
 * Правило живёт перекрытием в блоке страницы, потому что вес селекторов копии
 * (`.send:hover` — 0,2,0) перебивает её же `[disabled]` (0,1,0). Без этих двух
 * строк единственный акцентный элемент экрана во время платного запуска
 * выглядит ярче, чем в покое (замер `design-review`: 0.9 под мышью против
 * 0.5 без неё), а подпись запертого режима обещает выбор, которого не примут.
 */
test('запертая кнопка и запертый режим не отвечают наведению', () => {
  assert.match(own, /\.send\[disabled\]:hover \{[^}]*opacity:\.5/, 'запертая кнопка светлеет под мышью')
  assert.match(own, /\.mode:has\(input\[disabled\]\):hover \{[^}]*color:var\(--fg-mut\)/, 'подпись запертого режима светлеет')
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
    '2rem', '3rem', '5rem', '6rem', '7rem', '8rem', '10rem', // колонки сеток пп. 2.2, 6.3, 9.4 и таблицы кандидатов дня 23
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

/**
 * Зазор между полем вопроса и подписью «РЕЖИМ» — перенос держателя PR #309
 * (день 22), а не новое правило: страница скопирована с дня 22 до той правки,
 * и без этого теста решение владельца откатилось бы молча вместе с копией.
 *
 * Группы пульта идут в потоке формы, а не внутри `.sec > * + *`: правило копии
 * до них не достаёт, и свой отступ каждая обязана нести сама. У `.submit-row`
 * он есть, у `.modes` его не было — подпись «РЕЖИМ» стояла вплотную к нижней
 * рамке поля (замер дня 22: 0 px при 320, 768 и 1440).
 *
 * Проверка структурная, как и остальные здесь: поведение браузера ею не
 * доказывается. Её предмет в том, что шаг у двух соседних групп пульта ОДИН и
 * взят из шкалы.
 */
test('у переключателя режима есть отступ сверху тем же шагом, что у ряда кнопки', () => {
  const modes = own.match(/\.modes \{[^}]*\}/)
  assert.ok(modes, 'правила .modes нет вовсе')
  assert.match(modes[0], /margin:var\(--s-4\) 0 0/, 'подпись РЕЖИМ стоит вплотную к полю вопроса')
  // Шаг тот же, что у соседней группы: расхождение здесь и есть дефект ритма.
  assert.match(own, /\.submit-row \{[^}]*margin-top:var\(--s-4\)/, 'ряд кнопки сменил шаг — у .modes он осиротел')
})

/**
 * Число замера в живом документе — только измеренное. У дня 23 три варианта
 * режима вместо двух дня 22, поэтому число дня 22 (602 px) здесь было бы
 * ложным замером, а сумма «602 + высота ряда» — арифметикой, выданной за
 * замер (блокирующая `reviewer` к этому PR).
 */
test('комментарий бюджета первого экрана не несёт чужого замера', () => {
  // Читается СЫРАЯ разметка, а не `own`: предмет здесь — комментарий, и из
  // `own` комментарии сняты.
  const budget = page.slice(page.indexOf('Бюджет первого экрана'), page.indexOf('.sec-gap'))
  assert.ok(budget.length > 0, 'абзаца про бюджет первого экрана нет вовсе')
  assert.match(budget, /не мерено/, 'не сказано, что числа замера у этой страницы нет')
  // КООРДИНАТА на экране (трёхзначное число px) допустима в этом абзаце только
  // с указанием, чей это замер: неподписанная читается как замер этой
  // страницы, которого никто не делал. Шаги шкалы (16 px и прочие двузначные)
  // под правило не попадают — они не замер, а значение токена.
  // Окно, а не строка: комментарий переносится по ширине, и подпись замера
  // может стоять строкой выше самого числа.
  for (const hit of budget.matchAll(/\b\d{3,4} px\b/g)) {
    const window = budget.slice(Math.max(0, hit.index - 160), hit.index)
    assert.match(
      window,
      /дня 22/,
      `координата ${hit[0]} не подписана чужим днём: ${window.slice(-80).replace(/\s+/g, ' ')}`,
    )
  }
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

// Находка живой проверки в Chrome: обрыв вызова рисовался внутри
// `pre.rpc.is-empty`, который копия красит `--fg-mut`, поэтому единственное
// место ленты с `--danger` (раскладка, пп. 8.1, 10) красным НЕ БЫЛО — замер
// показал rgb(155,155,163) вместо rgb(242,184,181). Цвет даёт правило копии
// `.entry[data-kind="fail"] .entry-note`, значит строка обязана быть
// `.entry-note`, и это проверяется здесь: иначе правка вернётся молча.
test('обрыв вызова рисуется .entry-note, а пустой ответ службы — рамкой тела', () => {
  const app = stripJs(read('app.js'))
  // Строка обрыва идёт в `.entry-note` и возвращается ДО создания рамки.
  assert.match(app, /node\('p', 'entry-note', RPC_BROKEN\)/, 'обрыв вызова не в .entry-note')
  // Пустой ответ службы — наоборот, внутри рамки: служба ответила, и строка
  // страницы не должна притворяться байтами (правило копии `.rpc.is-empty`).
  assert.match(app, /missing \? RPC_EMPTY : shown/, 'пустой ответ службы не в рамке тела')
  // Класс `fail` ставится на запись ленты — без него правило копии не достанет.
  assert.match(app, /if \(broken\) li\.dataset\.kind = 'fail'/)
  // И мутация «обрыв тоже в рамку» краснит первую проверку, а не остаётся
  // зелёной: RPC_BROKEN внутри строки рамки быть не должно.
  assert.ok(!/is-empty[^\n]*RPC_BROKEN/.test(app), 'обрыв вызова снова уехал в рамку тела')
})

// Находка живой проверки: сводка собиралась как `dl` со `span` внутри — это и
// невалидная разметка (`dl` принимает только dt/dd/div), и клетка без
// заголовка столбца. У каждого числа сводки два заголовка — строки и столбца, —
// поэтому таблица с `scope`.
test('сводка итогов — таблица, и у клетки есть заголовок строки и столбца', () => {
  const app = stripJs(read('app.js'))
  assert.match(page, /<table class="sum" id="sum">/, 'сводка не таблица')
  assert.ok(!/<dl[^>]*id="sum"/.test(page), 'сводка снова dl')
  assert.match(app, /th\.scope = 'col'/, 'нет заголовка столбца')
  assert.match(app, /th\.scope = 'row'/, 'нет заголовка строки')
  assert.ok(!/node\('(?:dt|dd)'/.test(app), 'dt/dd вернулись в сводку')
})

/**
 * Решение «называть ли суточный предел исчерпанным» живёт В ОДНОМ месте.
 *
 * Правило держит `run.test.js` исполнением (`dayLimitNote`), но мутация
 * `compliance` стояла на ВЫЗОВЕ, а не в правиле: условие было вписано в
 * `app.js`, и его снятие оставляло прогон зелёным. Поэтому здесь
 * проверяется, что у страницы своего условия НЕТ и она спрашивает функцию, —
 * иначе правило обойдут, не тронув ни одной проверенной строки.
 */
test('страница не решает про суточный предел сама, а спрашивает dayLimitNote', () => {
  const app = stripJs(read('app.js'))
  assert.match(app, /dayLimitNote\(answer\.status, json\?\.retryAfterSec\)/, 'страница не спрашивает функцию')
  // Сам РАЗЛИЧИТЕЛЬ у страницы жить не должен: сравнение с `null` — это и есть
  // правило, и его место в `run.js`, под тестом исполнением.
  assert.ok(!/retryAfterSec === null/.test(app), 'различитель вернулся в страницу')
  // И строку страница не ставит напрямую, минуя правило.
  assert.ok(!/DAY_LIMIT_NOTE/.test(app), 'страница ставит строку напрямую, минуя правило')
  // Отдельно: `Number.isInteger(json?.retryAfterSec)` в строке состояния — это
  // ДРУГОЙ случай (приписка «Повторить можно через N с.»), и он остаётся: он не
  // решает, исчерпан ли суточный предел.
  assert.match(app, /Number\.isInteger\(json\?\.retryAfterSec\)/, 'приписка про секунды пропала')
})

/**
 * Обрыв потока переписывает ВСЕ ТРИ секции, и решение про источники страница
 * не принимает сама.
 *
 * Блокирующая `design-review` к PR #303: обработчик обрыва трогал только
 * строку состояния и примечание ленты, и «Ищу фрагменты…» оставалось на
 * экране навсегда. Правило держит `run.test.js` исполнением
 * (`tornSrcsNote`); здесь — что страница его СПРАШИВАЕТ в этой ветви и что
 * различителя у неё своего нет.
 */
test('обрыв потока переписывает источники и ответ, а решение спрашивает у tornSrcsNote', () => {
  const app = stripJs(read('app.js'))
  // Ветвь обрыва — от `onerror` до конца обработчика.
  const at = app.indexOf('stream.onerror')
  assert.ok(at > 0, 'обработчика обрыва нет')
  const branch = app.slice(at, app.indexOf('\n  }', at))
  assert.match(branch, /tornSrcsNote\(runMode, fragmentsFound\)/, 'ветвь обрыва не спрашивает правило')
  assert.match(branch, /showSrcsPlaceholder\(/, 'ветвь обрыва не трогает секцию источников')
  assert.match(branch, /ANSWER_TORN/, 'блок ответа остаётся пустой областью')
  // Второй слой у правила про ДЕНЬГИ. `run.test.js` держит саму константу
  // `ANSWER_TORN`, но блок складывается здесь, и рядом с константой можно
  // приписать своё утверждение о расходе — с оборванного потока не видно,
  // был ли вызов модели оплачен. Проба `compliance` к PR #303: вторая строка
  // «Вызов модели не случился — вопрос денег не стоил.» в этой ветви
  // оставляла все 121 тест зелёными.
  for (const word of ['денег', 'бесплатн', 'не стоил', 'потрачен'])
    assert.ok(!branch.includes(word), `ветвь обрыва утверждает про расход: ${word}`)
  // И ответ правила обязан использоваться, а не быть вычислен и выброшен.
  assert.match(branch, /showSrcsPlaceholder\(tornNote\)/, 'ответ правила не используется')
  // Различитель — в правиле, не в странице. Проверяется ВЕТВЬ, а не файл:
  // `fragmentsFound === null` живёт и в строке состояния (`app.js:389`,
  // STATUS.askingPlain), и это другой случай — запрет на весь файл запретил
  // бы верный код.
  assert.ok(!/fragmentsFound === null/.test(branch), 'различитель обрыва вернулся в страницу')
  assert.ok(!/SRCS_TORN/.test(app), 'страница ставит строку напрямую, минуя правило')
  // Режим берётся у ЗАПУСКА, а не у радиокнопки: к обрыву она уже отперта.
  assert.match(app, /runMode = starting \? mode : null/, 'режим запуска не запоминается')
  assert.ok(!/tornSrcsNote\(chosenMode\(\)/.test(app), 'спрошена радиокнопка вместо режима запуска')
})

/**
 * Четыре правила показа, у которых в CI не было держателя вовсе.
 *
 * ЧЕСТНО О МЕТОДЕ: проверки структурные, как у фокуса выше. Поведение этих
 * правил доказано живым прогоном в Chrome, но живого прогона в CI нет, и оба
 * гейта измерили это независимо: откат каждой из правок круга 2 оставлял все
 * 110 тестов зелёными (находки `reviewer` и `compliance` к PR #303). Утвердить
 * поведение здесь нельзя — можно утвердить, что строка, которая его держит, на
 * месте. Это слабее живого замера и сильнее ничего.
 */
test('пустое состояние «Ответ» привязано к факту запуска, а не прибито к false', () => {
  const app = stripJs(read('app.js'))
  assert.match(app, /answerEmpty\.hidden = starting/, 'пустое состояние показывается во время запуска')
  // Прибитое значение вернуло бы дефект: «Вопроса ещё не было…» рядом со
  // «Спрашиваю модель…».
  // Прежняя редакция этой строки не могла покраснеть ни на чём: правый
  // операнд `||` совпадал всегда — `answerEmpty.hidden = true` стоит в файле
  // трижды (находка `reviewer` к PR #303). Утверждается то, что правило
  // держит: внутри `resetRun` присваивание `.hidden` этому узлу РОВНО одно, и
  // оно — `= starting`.
  const reset = app.slice(app.indexOf('function resetRun'))
  const body = reset.slice(0, reset.indexOf('\n}') + 2)
  const assigns = [...body.matchAll(/answerEmpty\.hidden = ([^\n;]+)/g)].map((m) => m[1].trim())
  assert.deepEqual(assigns, ['starting'], 'в resetRun пустое состояние ставится не фактом запуска')
})

test('в режиме без отбора секция «Отбор» не обещает кандидатов, которых не будет', () => {
  const app = stripJs(read('app.js'))
  // Режим доходит до `resetRun` с вызывающей стороны…
  assert.match(app, /resetRun\(\{ starting: true, mode \}\)/, 'режим не передан в сброс пульта')
  // …и решает, что ставить в секцию «Отбор»: второй ступени в режиме `rag`
  // нет вовсе, и «кандидаты появятся здесь» висело бы весь запуск обещанием
  // шага, которого в этом режиме не бывает — тот же дефект, что `reviewer`
  // нашёл в дне 22 для строки поиска в режиме без RAG.
  assert.match(
    app,
    /mode === 'rag' \? CANDIDATES_RAG : PICK_RUNNING/,
    'строка кандидатов ставится без учёта режима',
  )
})

test('состояние загрузки итогов ставится ДО запроса файла', () => {
  const app = stripJs(read('app.js'))
  // Ищется ВЫЗОВ, который строку ставит, а не объявление постоянной: объявление
  // стоит выше всегда, и проверка по имени оставалась зелёной при снятом вызове
  // (своя находка при прогоне мутации).
  const set = app.search(/evalState\.replaceChildren\(node\([^)]*EVAL_LOADING\)\)/)
  const fetched = app.indexOf("fetch('eval.json')")
  assert.notEqual(set, -1, 'строку загрузки итогов никто не ставит')
  assert.notEqual(fetched, -1, 'запроса файла итогов нет')
  assert.ok(set < fetched, 'строка загрузки ставится после запроса — значит её не видно')
})

test('на экране есть место, где назван отказ модели как результат (п. 5.3)', () => {
  const app = stripJs(read('app.js'))
  assert.ok(app.includes('REFUSED_NOTE'), 'строка-пояснение к отказу не показывается')
  // Признак отказа читается в `run.js`: что стоит в блоке ответа, решает
  // `answerBlock`, и это вынесено туда ради держателя, который исполняется.
  const run = stripJs(read('run.js'))
  assert.ok(run.includes('refusedNote: result.refused'), 'признак отказа не читается')
  assert.ok(app.includes('block.refusedNote'), 'страница решает про отказ сама, мимо правила')
  // Отказ не красится: класса --danger у него нет, он идёт обычной записью.
  assert.ok(!/refused[^\n]*is-bad/.test(app))
})

test('подвал говорит про отсутствие хранения, общее окно службы и прогон', () => {
  const footer = page.slice(page.indexOf('<footer>'), page.indexOf('</footer>'))
  assert.match(footer, /сессий, cookie и переписки у этого дня нет/)
  assert.match(footer, /Окно службы одно на всех посетителей этого дня/)
  assert.match(footer, /через этот же публичный адрес/)
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
