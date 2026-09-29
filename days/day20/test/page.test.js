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
// Поле стало многострочным (раскладка 2026-09-28-1912, п. 6.1: задание —
// фраза), но id сохранён намеренно: пять состояний поля живут в копии дня 16
// правилами `#cmd`, и своего набора состояний страница не заводит.
test('текстовое поле носит id, который оформляет style.css, и его же ищет app.js', () => {
  const m = page.match(/<textarea id="([^"]+)"/)
  assert.ok(m, 'текстового поля на странице нет')
  const id = m[1]
  assert.match(read('style.css'), new RegExp(`#${id}\\s*\\{`), `style.css не оформляет #${id}`)
  assert.ok(stripJs(read('app.js')).includes(`byId('${id}')`), `app.js не ищет #${id}`)
})

// Цену экран обязан назвать ДО кнопки. Раньше это держал блок пояснения,
// стоявший над формой; в диалоге пояснение переехало в правую колонку, а цену
// несёт строка `.wire` в шапке левой (раскладка, п. 3.2). Предмет проверки тот
// же и место у него одно: строка цены, а не блок пояснения.
//
// Порядок в разметке и есть порядок на экране: ни `order`, ни перестановок
// grid в правилах страницы нет — это проверяется здесь же, иначе строка могла
// бы стоять выше в разметке и ниже на экране.
test('строка цены стоит выше формы и называет платность словом', () => {
  const wire = page.indexOf('<p class="wire">')
  const form = page.indexOf('<form class="composer"')
  assert.notEqual(wire, -1, 'строки цены на странице нет')
  assert.notEqual(form, -1, 'формы на странице нет')
  assert.ok(wire < form, 'строка цены стоит ниже кнопки «Отправить»')
  const line = page.slice(wire, page.indexOf('</p>', wire))
  assert.match(line, /платный/, 'строка цены не называет вызов платным')
  // Числа суточного предела в разметке быть не должно: достоверно оно только
  // в отказе 429 от сервера (раскладка, п. 3.2).
  assert.ok(!/\b50\b/.test(line), `суточный предел вписан в разметку: ${line}`)
  const own = page.slice(page.indexOf('<style>'), page.indexOf('</style>'))
  assert.ok(!/\border\s*:/.test(own) && !/grid-template-areas/.test(own),
    'раскладка переставляет блоки — порядок разметки перестал быть порядком на экране')
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

// Класс пустого состояния и сам текст обязаны решаться ОДНИМ местом. Пока
// решений было два, на пробельном тексте wordsText уже говорил «без слов», а
// .is-none не вставал — круг выглядел пустой полосой под подписью.
test('класс пустого состояния берётся из того же решения, что и текст', () => {
  const m = code.match(/node\('p', `words\$\{([^?]+)\?/)
  assert.ok(m, 'класс пустого состояния ставится не там, где ожидает проверка')
  assert.equal(m[1].trim(), 'isSilent(words)', `класс решается отдельно от текста: ${m[1].trim()}`)
})

// Две формы записи в ленте должны различаться БЕЗ чтения текста (раскладка дня
// 20, критерий 4). Проверка идёт ОТ ЗНАЧЕНИЯ, которое ставит trace.js: не будет
// правила под это значение — обе записи снова станут одной карточкой, как и
// доехало до ревью. style.css трогать нельзя, поэтому правило ищется в <style>.
test('запись со словами отличается от карточки вызова без чтения текста', () => {
  const trace = stripJs(read('trace.js'))
  const kind = trace.match(/li\.dataset\.kind = '(\w+)'/)
  assert.ok(kind, 'запись со словами ничем не помечена в разметке')
  const style = page.slice(page.indexOf('<style>'), page.indexOf('</style>'))
  const sel = `.entry[data-kind="${kind[1]}"]`
  const rule = style.slice(style.indexOf(sel))
  assert.notEqual(style.indexOf(sel), -1, `правила под ${sel} нет ни в одном стиле страницы`)
  const own = rule.slice(0, rule.indexOf('}'))
  assert.match(own, /border:\s*0/, `у ${sel} осталась рамка карточки вызова`)
  assert.match(own, /border-left:/, `у ${sel} нет левой линейки`)

  // Пояснение об обрыве ограничивает смысл записи — и до правки было шире
  // прозы, которую ограничивает: 82 знака в строке против 68.
  const note = style.slice(style.indexOf(`${sel} .entry-note`))
  assert.notEqual(style.indexOf(`${sel} .entry-note`), -1, `у пояснения записи ${sel} нет своей полосы чтения`)
  assert.match(note.slice(0, note.indexOf('}')), /max-width:\s*68ch/, 'пояснение шире прозы, которую ограничивает')
})

// Оговорка «связь слова → вызов не проверяется» стоит в блоке пояснения выше
// формы — при 1440x900 её низ на 656 px, а верх ленты на 994: когда лента на
// экране, оговорки уже нет в кадре. Раскладка требует её строкой над лентой.
test('оговорка о непроверяемой связи стоит над лентой, а не только в блоке пояснения', () => {
  const feed = page.indexOf('<ol class="feed"')
  // Шапок `.feed-head` на странице теперь две — у диалога и у ленты. Берётся
  // ближайшая СВЕРХУ к ленте: с первой срез накрыл бы обе колонки и оговорка
  // в левой сошла бы за оговорку над лентой.
  const head = page.lastIndexOf('<div class="feed-head">', feed)
  assert.notEqual(feed, -1, 'ленты на странице нет')
  assert.notEqual(head, -1, 'шапки ленты на странице нет')
  const above = page.slice(head, feed)
  assert.ok(above.includes('ничем не проверяется'), 'над лентой нет оговорки о непроверяемой связи')
  assert.ok(above.includes('не протокол выбора'), 'над лентой не сказано, что это слова, а не протокол')
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

// ——— Диалог (ADR 2026-09-28-1852, заход 2; раскладка 2026-09-28-1912).

// Два потока на экране живут порознь, и это утверждение о разметке: разговор
// и лента хода — разные списки под разными заголовками. Слипнись они в один
// `<ol>`, хронология вызовов перемешалась бы с репликами и «как шёл ход»
// перестало бы читаться (раскладка, п. 0).
test('разговор и лента хода — два разных списка, каждый со своим заголовком', () => {
  const log = page.match(/<ol class="log" id="(\w+)" aria-labelledby="([\w-]+)"/)
  const feed = page.match(/<ol class="feed" id="(\w+)" aria-labelledby="([\w-]+)"/)
  assert.ok(log, 'списка реплик на странице нет')
  assert.ok(feed, 'ленты хода на странице нет')
  assert.notEqual(log[1], feed[1])
  assert.notEqual(log[2], feed[2], 'оба списка подписаны одним заголовком')
  for (const id of [log[2], feed[2]]) assert.match(page, new RegExp(`id="${id}"`), `заголовка ${id} нет`)
})

// Слова модели в разговор не попадают и попасть не могут: модуль разговора их
// не рисует вовсе. Проверка идёт по импортам, а не по тексту: переименуют
// функцию — покраснеет, а не позеленеет молча.
test('модуль разговора не рисует слов модели: диалог и лента хода не смешиваются', () => {
  const chat = stripJs(read('chat.js'))
  assert.ok(!chat.includes('renderWords'), 'разговор рисует слова модели — это запрещено раскладкой (п. 10.2)')
  assert.ok(!chat.includes('renderCall'), 'разговор рисует тела вызовов')
  // Слова кругов разговор всё-таки РАЗБИРАЕТ: они лежат в meta ответа агента
  // и тем же разбором уходят в ленту хода.
  assert.ok(chat.includes('parseWords'), 'слова кругов из переписки не разбираются')
})

// Восстановление после перезагрузки экран обязан назвать словами: переписка
// возвращается, слова модели последнего хода возвращаются, сырые тела вызовов
// — нет. Молчание об этом читалось бы как «ход пропал целиком».
test('восстановление названо словами: что вернулось и что не вернётся', () => {
  assert.match(page, /<p class="restored" id="restored" hidden><\/p>/, 'места для строки восстановления нет')
  const app = stripJs(read('app.js'))
  const block = app.slice(app.indexOf('const RESTORED_WITH_WORDS'), app.indexOf('const calls'))
  // Слов рядом с ответом может не быть — тогда восстановленный ход не
  // обещается: у страницы для этого случая своя строка, а не та же самая.
  assert.match(block, /RESTORED_WITHOUT_WORDS/, 'случай «слов не записано» назван тем же текстом')
  // Срок жизни тел вызовов обязана назвать КАЖДАЯ из двух строк: посетитель
  // видит одну из них, и «названо где-то в коде» ему ничего не даёт.
  const strings = block.split(/const RESTORED_/).filter((x) => x.includes('='))
  assert.equal(strings.length, 2, `строк восстановления в коде: ${strings.length}`)
  for (const one of strings) {
    assert.match(one, /восстановлена/)
    assert.match(one, /10 минут/, `срок жизни тел вызовов не назван: ${one.slice(0, 40)}`)
  }
  assert.match(block, /слова модели/)
})

// Лента хода показывает ОДИН ход — текущий. Новое сообщение её очищает и не
// трогает разговор (ADR, заход 2, п. 3). Очистка стоит ПОСЛЕ ответа 202:
// при отказе ход не начинался, и стирать показанное не за что.
test('ход очищает ленту только после того, как сервер его принял', () => {
  const app = stripJs(read('app.js'))
  const start = app.indexOf("form.addEventListener('submit'")
  const refusal = app.indexOf('answer.status !== 202', start)
  const accepted = app.indexOf("input.value = ''", refusal)
  const reset = app.indexOf('resetRun()', accepted)
  assert.ok(start !== -1 && refusal !== -1, 'отправки или проверки ответа в коде нет')
  // ДО ответа сервера лента не трогается вовсе: при отказе ход не начинался,
  // и стирать показанное не за что. Именно здесь была бы ошибка «очистили, а
  // ход не пошёл», поэтому проверяется весь отрезок, а не одна строка.
  const beforeAnswer = app.slice(start, refusal)
  assert.ok(!beforeAnswer.includes('resetRun'), `лента очищается до ответа сервера: ${beforeAnswer.slice(-160)}`)
  assert.ok(reset !== -1 && reset - accepted < 200, 'после принятого хода лента не очищается')
  // Разговор при этом не трогается: `resetRun` о логе реплик не знает.
  const body = app.slice(app.indexOf('function resetRun'), app.indexOf('function showServers'))
  assert.ok(!body.includes('log.'), `очистка ленты трогает разговор: ${body}`)
})

// Идентификатор сессии странице не виден и не нужен: его чеканит сервер и
// кладёт в cookie HttpOnly. Появись он в клиентском коде — значит, кто-то
// решил читать или подставлять его из браузера.
test('идентификатор сессии в клиентский код не попадает', () => {
  assert.ok(!code.includes('document.cookie'), 'страница читает cookie')
  assert.ok(!/sessionId/.test(code), 'идентификатор сессии появился в клиентском коде')
})

// Живой прогон поймал то, чего текстовые проверки не ловили: восстановление
// клало круги в ленту и тут же вызывало очистку ленты, так что после
// перезагрузки строка «переписка восстановлена» стояла над ПУСТОЙ лентой.
// Проверка стоит на месте той ошибки: путь восстановления очистку не зовёт.
test('восстановление ленты не проходит через её очистку', () => {
  const app = stripJs(read('app.js'))
  const body = app.slice(app.indexOf('function showRestored'), app.indexOf('function showChat'))
  assert.ok(body.includes('items.push'), 'восстановление ничего не кладёт в ленту')
  assert.ok(!body.includes('resetRun'), 'восстановление зовёт очистку ленты — круги стираются сразу после укладки')
  assert.ok(!/items\.length\s*=/.test(body), 'восстановление обнуляет ленту')
})

// ——— Правки гейта раскладки.

// Пустое состояние обязано называть НАСТОЯЩУЮ причину пустоты. У ответа агента
// слов рядом может не быть вовсе (ход оборвался), и тогда лента пуста, а ход
// всё-таки был: строка «Хода ещё не было» стояла бы в одном кадре со строкой
// «переписка восстановлена», и правая была бы ложью. Поэтому обе строки
// привязаны к ФАКТУ восстановления, а не к тому, нашлись ли слова.
test('пустые состояния ленты привязаны к факту восстановления, а не к наличию слов', () => {
  const app = stripJs(read('app.js'))
  // Границы среза — по КОДУ, а не по комментариям: `stripJs` комментарии уже
  // снял, ненайденная граница дала бы срез во весь файл, и проверка стала бы
  // зелёной на любом коде, где слово встречается хоть где-то.
  const cut = (from, to) => {
    const a = app.indexOf(from)
    const b = app.indexOf(to, a + 1)
    assert.ok(a !== -1 && b > a, `границы среза не найдены: ${from} … ${to}`)
    return app.slice(a, b)
  }
  const draw = cut('function redraw', 'function resetRun')
  assert.ok(draw.includes('restoredRun'), 'текст пустой ленты не смотрит на факт восстановления')
  const servers = cut('function showServers', 'function showChat')
  assert.ok(servers.includes('restoredRun'), 'подпись серверов не смотрит на факт восстановления')
  assert.ok(!servers.includes('items.length'), 'подпись серверов всё ещё привязана к наличию слов')
  // Флаг ставится независимо от того, нашлись ли круги: иначе оборванный ход
  // снова читался бы как «хода не было».
  const restore = cut('function showRestored', 'function showChat')
  const flag = restore.indexOf('restoredRun = true')
  assert.notEqual(flag, -1, 'факт восстановления нигде не отмечается')
  assert.ok(!/rounds\.length[^\n]*restoredRun = true/.test(restore), 'факт восстановления зависит от числа кругов')
})

// Умолчания стоят в разметке, а переключение — в коде. Разойдись они, экран
// показал бы один текст до первого обновления и другой после, и заметить это
// было бы нечем.
test('умолчания пустых состояний в разметке совпадают с текстами в коде', () => {
  const app = stripJs(read('app.js'))
  const constant = (name) => {
    const at = app.indexOf(`const ${name} =`)
    assert.notEqual(at, -1, `постоянной ${name} нет`)
    const tail = app.slice(at, app.indexOf('\nconst ', at + 1))
    return [...tail.matchAll(/'([^']*)'/g)].map((m) => m[1]).join('')
  }
  for (const [name, id] of [['FEED_NEVER', 'empty'], ['SERVERS_NEVER', 'servers-note']]) {
    const at = page.indexOf(`id="${id}"`)
    assert.notEqual(at, -1, `элемента ${id} на странице нет`)
    const markup = page.slice(page.lastIndexOf('<', at), page.indexOf('</p>', at))
    const text = markup.slice(markup.indexOf('>') + 1).replace(/\s+/g, ' ').trim()
    assert.equal(text, constant(name).replace(/\s+/g, ' ').trim(), `умолчание ${id} разошлось с ${name}`)
  }
})

// Запертый элемент отдаёт фокус телу документа и сам его не возвращает. Для
// экрана-переписки это значит поиск поля заново перед каждым сообщением
// (раскладка, п. 8.6). Возврат — не угон: страница отдаёт то, что забрала, и
// только если фокус был на том, что она заперла.
test('фокус возвращается в поле после отпирания, и только если страница его забрала', () => {
  const app = stripJs(read('app.js'))
  const body = app.slice(app.indexOf('function lock(on)'), app.indexOf('function redraw'))
  assert.match(body, /document\.activeElement/, 'страница не смотрит, был ли фокус на запираемом')
  assert.match(body, /input\.focus\(\)/, 'фокус в поле не возвращается')
  // Возврат стоит ПОД условием: безусловный `focus()` при каждом отпирании
  // уводил бы посетителя из ленты, которую он в этот момент читает.
  const back = body.indexOf('input.focus()')
  assert.ok(/if \(!on && refocus\)/.test(body.slice(0, back)), `фокус возвращается безусловно: ${body.slice(0, back).slice(-120)}`)
  // Второе условие проверяется В МОМЕНТ ВОЗВРАТА, а не захвата. Ход идёт
  // секунды, и за это время посетитель успевает уйти по Tab в тело вызова:
  // условие, посчитанное при отправке, к концу хода устаревает, и каретка
  // прыгает из читаемого JSON-RPC в поле — тот самый угон (п. 10.6).
  assert.match(body.slice(back - 80, back), /document\.activeElement === document\.body/, 'возврат не смотрит, где фокус СЕЙЧАС')
})

// На широком экране прокручивается ЛОГ, а не левая колонка целиком: иначе
// форма уходит за нижний край на седьмой реплике. Раскладка говорит об этом в
// п. 2.1 дважды и по-разному (картинка против CSS); выбрана картинка, довод —
// в комментарии у правила и в описании PR.
test('на широком экране прокручивается лог, а форма остаётся в колонке', () => {
  const own = page.slice(page.indexOf('<style>'), page.indexOf('</style>'))
  const wide = own.slice(own.indexOf('@media (min-width:75rem)'))
  assert.match(wide, /\.col-talk \.log \{[^}]*overflow-y:auto/, 'лог на широком экране не прокручивается сам')
  // У лога минимум высоты из шкалы отступов: без него `overflow` колонки
  // отдаёт логу «что осталось», а при низком окне не остаётся ничего —
  // разговор исчезает целиком, а композитор режется. Медиазапрос смотрит
  // только на ширину, поэтому низкое окно на широком экране — обычный случай.
  assert.match(wide, /\.col-talk \.log \{[^}]*min-height:calc\(2 \* var\(--s-8\)\)/, 'лог может схлопнуться в ноль')
  // Колонка при этом прокручивается САМА: иначе при нехватке высоты не
  // достать ни разговор, ни форму — резать нечем и прокрутить нечем.
  assert.match(wide, /\.col-talk \{[^}]*overflow-y:auto/, 'левой колонке нечем прокрутиться при нехватке высоты')
  // Правая колонка прокручивается по-прежнему целиком: под лентой там стоят
  // пояснение и подвал, и отрывать их незачем.
  assert.match(wide, /\.col-run \{[^}]*overflow-y:auto/, 'правая колонка перестала прокручиваться')
  assert.ok(page.includes('class="col col-talk"') && page.includes('class="col col-run"'), 'колонки не различены в разметке')
})
