// Страница дня 26 грузит один обычный скрипт — site/day26/app.js. Тест
// повторяет именно это: vm.Script в контексте без DOM, нестрогий режим снаружи,
// — а не импорт модуля.
//
// Ради чего: у дня 21 голый блок в первом скрипте выпускал функции в глобальную
// область, и второй падал с SyntaxError — страница вечно «читала результаты»
// (находка design-review к #295). У дня 26 скрипт один, но та же ловушка живёт
// в любой опечатке верхнего уровня: без этого теста падение видно только в
// браузере, потому что site/ не единица CI.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')

function loadPage() {
  // Минимум окружения: на верхнем уровне app.js объявляет функции, размечает
  // прокручиваемые области и зовёт fetch. fetch не завершается — рендер здесь
  // не проверяется, проверяется загрузка.
  const ctx = vm.createContext({
    fetch: () => new Promise(() => {}),
    console,
    document: { querySelectorAll: () => [] },
    window: { addEventListener: () => {} },
  })
  new vm.Script(read('../site/day26/app.js'), { filename: 'app.js' }).runInContext(ctx)
  return ctx
}

test('app.js дня 26 грузится без ошибки', () => {
  assert.doesNotThrow(loadPage)
})

// Подложный DOM: ровно столько, сколько трогает app.js. Нужен, чтобы
// проверить поведение состояний, а не только загрузку файла. Объявления
// функций обычного скрипта попадают в глобальную область контекста vm,
// поэтому render и showMessage здесь вызываются напрямую.
function fakeDom() {
  const nodes = new Map()
  const mk = (name) => ({
    name, hidden: false, textContent: '', className: '', scope: '', href: '',
    children: [], scrollWidth: 0, clientWidth: 0,
    appendChild(n) { this.children.push(n); return n },
    setAttribute() {}, removeAttribute() {}, addEventListener() {},
    querySelector() { return null }, focus() {},
    get childElementCount() { return this.children.length },
  })
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, mk(id))
      return nodes.get(id)
    },
    createElement: (t) => mk(t),
    querySelectorAll: () => [],
  }
  const ctx = vm.createContext({
    fetch: () => new Promise(() => {}), console, document,
    window: { addEventListener: () => {} },
    location: { hash: '' },
  })
  new vm.Script(read('../site/day26/app.js'), { filename: 'app.js' }).runInContext(ctx)
  return { ctx, nodes, get: (id) => document.getElementById(id) }
}

const DATA = () => JSON.parse(read('../site/day26/results.json'))

// Ради чего: пустая таблица с одними заголовками обещает числа, которых нет.
// Так и было до правки — блок «Скорость против предсказуемости текста»
// оставался на экране пустым в трёх состояниях из четырёх (design-review к #339).
for (const [name, mutate] of [
  ['файла нет или он негоден', () => ({})],
  ['чужой день в файле', () => ({ ...DATA(), day: 29 })],
  ['прогона ещё не было', () => ({ ...DATA(), prompts: [] })],
  ['проверки скорости в прогоне нет', () => {
    const d = DATA(); delete d.speed_vs_content; delete d.speculative; return d
  }],
]) {
  test('блок скорости не остаётся пустой таблицей: ' + name, () => {
    const dom = fakeDom()
    dom.ctx.render(mutate())
    assert.equal(dom.get('svc-box').hidden, true, 'блок с таблицей скорости остался на экране')
    assert.equal(dom.get('svc-status').hidden, false, 'причины на месте блока нет')
    assert.ok(dom.get('svc-status').textContent.length > 0, 'причина пуста')
    assert.equal(dom.get('svc-body').children.length, 0, 'в таблице скорости появились строки')
  })
}

test('на полных данных блок скорости и ловушки /v1 показаны', () => {
  const dom = fakeDom()
  dom.ctx.render(DATA())
  assert.equal(dom.get('svc-box').hidden, false)
  assert.equal(dom.get('svc-status').hidden, true)
  assert.ok(dom.get('svc-body').children.length > 0, 'строк скорости нет')
  assert.equal(dom.get('traps').hidden, false, 'ловушки /v1 спрятаны при полных данных')
  assert.equal(dom.get('opts-p').hidden, false, 'строка параметров спрятана при полных данных')
})

// Доля принятых черновиков — сводная за прогон. Разбивки по типам текста
// замер не записал, и страница не вправе называть долю для русской прозы
// (находка design-review к #339: число не из данных и спорило с таблицей).
test('доли принятых черновиков по типам текста в данных нет и на странице тоже', () => {
  const d = DATA()
  assert.equal(d.speculative.accepted_fraction.by_text_kind, null)
  const html = read('../site/day26/index.html')
  assert.ok(!/около трети|почти все \d|принимается [а-я]+ треть/.test(html),
    'доля принятых черновиков названа прозой, а не взята из данных')
})

test('index.html дня 26 грузит app.js и не грузит ничего с CDN', () => {
  const html = read('../site/day26/index.html')
  assert.ok(html.includes('src="app.js"'), 'app.js не подключён')
  assert.ok(!/(src|href)="https?:\/\/[^"]*\.(js|css)"/.test(html), 'есть запрос к сторонним скриптам или стилям')
})

// Форма файла данных: страница встаёт в «ошибка» при чужом day, и это ловится
// только здесь — site/ не единица CI, валидатора results.json нет (Р-3).
test('results.json дня 26 несёт свой день, повторы и прогоны с вердиктами', () => {
  const d = JSON.parse(read('../site/day26/results.json'))
  assert.equal(d.day, 26)
  assert.equal(typeof d.repeats, 'number')
  assert.ok(Array.isArray(d.prompts) && d.prompts.length > 0, 'прогонов нет')
  const allowed = new Set(['верно', 'частично', 'неверно'])
  const howAllowed = new Set(['механически', 'вручную', 'судья'])
  for (const p of d.prompts) {
    assert.ok(allowed.has(p.verdict), 'недопустимый вердикт: ' + p.verdict)
    assert.ok(howAllowed.has(p.scored_by), 'недопустимый способ оценки: ' + p.scored_by)
    assert.equal(typeof p.id, 'string')
    assert.ok(p.answer.length > 0, 'ответ модели пуст у ' + p.id)
  }
})

// I-1, I-3, I-10: страница публичная. Адрес частной сети, имя машины в ней и
// значение ключа в данных и в разметке — дефект, а не недосмотр.
test('ни в данных, ни в разметке дня 26 нет адресов частной сети и имён машин', () => {
  const texts = [read('../site/day26/results.json'), read('../site/day26/index.html'),
    read('../site/day26/app.js')]
  for (const t of texts) {
    assert.ok(!/\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/.test(t),
      'адрес частной сети Tailscale в тексте страницы')
    assert.ok(!/[A-Za-z0-9-]+\.ts\.net/.test(t), 'имя машины в частной сети в тексте страницы')
    assert.ok(!/s[k]-ant-|EVAL_KEY=\S/.test(t), 'похожее на значение ключа в тексте страницы')
  }
})
