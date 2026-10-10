// Страница дня 30 грузит один обычный скрипт — site/day30/app.js. Тест
// повторяет именно это: vm.Script в контексте без DOM, нестрогий режим снаружи,
// — а не импорт модуля.
//
// Ради чего: у дня 21 голый блок в первом скрипте выпускал функции в глобальную
// область, и второй падал с SyntaxError — страница вечно «читала результаты»
// (находка design-review к #295). У дня 30 скрипт один, но та же ловушка живёт
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
  new vm.Script(read('../site/day30/app.js'), { filename: 'app.js' }).runInContext(ctx)
  return ctx
}

test('app.js дня 30 грузится без ошибки', () => {
  assert.doesNotThrow(loadPage)
})

// Подложный DOM: ровно столько, сколько трогает app.js. Объявления функций
// обычного скрипта попадают в глобальную область контекста vm, поэтому render
// и verdictText здесь вызываются напрямую.
function fakeDom() {
  const nodes = new Map()
  const mk = (name) => ({
    name, hidden: false, textContent: '', className: '', scope: '',
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
  })
  new vm.Script(read('../site/day30/app.js'), { filename: 'app.js' }).runInContext(ctx)
  return { ctx, get: (id) => document.getElementById(id) }
}

const DATA = () => JSON.parse(read('../site/day30/results.json'))

// Ради чего: пустая таблица с одними заголовками обещает числа, которых нет
// (находка design-review к #339 на соседней странице недели).
for (const [name, mutate] of [
  ['файла нет или он негоден', () => ({})],
  ['чужой день в файле', () => ({ ...DATA(), day: 29 })],
  ['прогона ещё не было', () => ({ ...DATA(), burst: [], limits: [] })],
  ['проб с несколькими запросами в прогоне нет', () => ({ ...DATA(), burst: [] })],
]) {
  test('таблица параллельных запросов не остаётся пустой сеткой: ' + name, () => {
    const dom = fakeDom()
    dom.ctx.render(mutate())
    assert.equal(dom.get('burst-tbl').hidden, true, 'таблица осталась на экране без строк')
    assert.equal(dom.get('burst-status').hidden, false, 'причины на месте таблицы нет')
    assert.ok(dom.get('burst-status').textContent.length > 0, 'причина пуста')
    assert.equal(dom.get('burst-body').children.length, 0, 'в таблице появились строки')
  })
}

test('негодный файл: таблица ограничений и блок доступа тоже сняты', () => {
  const dom = fakeDom()
  dom.ctx.render({})
  assert.equal(dom.get('lim-tbl').hidden, true)
  assert.equal(dom.get('acc-box').hidden, true)
  assert.ok(dom.get('verdict').textContent.includes('results.json'),
    'состояние «ошибка» не названо')
})

// Главное место, где страница может соврать молча: при выключенной частной
// сети пробы через прод дают один и тот же ответ и гипотез не различают.
// Вывод дня в этом случае не считается.
test('частная сеть выключена: вывод дня не считается', () => {
  const d = DATA()
  const prod = d.burst.find((r) => /публичн/i.test(r.path))
  prod.served = 0
  prod.refused = prod.requests
  const dom = fakeDom()
  dom.ctx.render(d)
  const text = dom.get('verdict').textContent
  assert.ok(text.includes('Вывод будет после полного прогона'),
    'вывод посчитан по пробам, которые гипотез не различают: ' + text)
  assert.ok(!/Сервис доступен снаружи/.test(text), 'страница объявила сервис доступным')
})

test('на полных данных вывод дня, таблицы и подвал показаны', () => {
  const dom = fakeDom()
  const d = DATA()
  dom.ctx.render(d)
  assert.equal(dom.get('burst-tbl').hidden, false)
  assert.equal(dom.get('lim-tbl').hidden, false)
  assert.equal(dom.get('acc-box').hidden, false)
  assert.ok(dom.get('burst-body').children.length === d.burst.length, 'строк проб нет')
  assert.ok(dom.get('lim-body').children.length === d.limits.length, 'строк ограничений нет')
  assert.ok(dom.get('verdict').textContent.includes('Сервис доступен снаружи'),
    'вывод дня не посчитан: ' + dom.get('verdict').textContent)
  assert.ok(dom.get('run-line').textContent.includes(d.commit), 'строки прогона нет')
  // Отказ без причины читался бы как сбой сервиса, а он выбор конфигурации.
  const reasons = dom.get('burst-reasons').textContent
  const refusedRow = d.burst.find((r) => r.refused > 0)
  assert.ok(reasons.includes(refusedRow.reason), 'причина отказа не названа: ' + reasons)
})

// Непроверенное ограничение — «не проверялось», а не «нет» и не пустая ячейка:
// защита без отрицательной пробы не проверена (I-14 по духу).
test('непроверенное ограничение помечено словом, а не пустой ячейкой', () => {
  const dom = fakeDom()
  const d = DATA()
  d.limits = [{ name: 'потолок размера запроса у роутера', value: '6000', fired: null, client_saw: '' }]
  dom.ctx.render(d)
  const cells = dom.get('lim-body').children[0].children.map((c) => c.textContent)
  assert.ok(cells.includes('не проверялось'), 'третий случай не показан: ' + cells.join(' | '))
  assert.ok(dom.get('lim-sum').textContent.includes('не проверено') ||
    dom.get('lim-sum').textContent.includes('не проверялось'),
  'сводка не говорит, что проверки не было: ' + dom.get('lim-sum').textContent)
})

test('index.html дня 30 грузит app.js и не грузит ничего с CDN', () => {
  const html = read('../site/day30/index.html')
  assert.ok(html.includes('src="app.js"'), 'app.js не подключён')
  // Проверяются именно загружаемые ресурсы, а не всякий внешний адрес:
  // ссылки на файлы кода в репозитории (…/limits.js, …/health.js) ведут на
  // GitHub и запросом страницы не являются.
  assert.ok(!/<(?:script|link)\b[^>]*(?:src|href)="https?:\/\//.test(html),
    'есть запрос к сторонним скриптам или стилям')
})

// Форма файла данных: страница встаёт в «ошибка» при чужом day, и это ловится
// только здесь — site/ не единица CI, валидатора results.json нет (Р-3).
test('results.json дня 30 несёт свой день, повторы, пробы и ограничения', () => {
  const d = DATA()
  assert.equal(d.day, 30)
  assert.equal(typeof d.repeats, 'number')
  assert.ok(Array.isArray(d.burst) && d.burst.length > 0, 'проб нет')
  assert.ok(Array.isArray(d.limits) && d.limits.length > 0, 'ограничений нет')
  for (const r of d.burst) {
    assert.equal(typeof r.path, 'string')
    for (const k of ['requests', 'served', 'refused', 'total_s']) {
      assert.equal(typeof r[k], 'number', k + ' у пути ' + r.path + ' не число')
    }
    assert.equal(r.served + r.refused, r.requests, 'обслужено и отказано не сходятся с числом запросов у ' + r.path)
  }
  for (const l of d.limits) {
    assert.equal(typeof l.name, 'string')
    assert.ok(l.fired === true || l.fired === false || l.fired === null,
      'fired не true/false/null у ограничения ' + l.name)
  }
})

// ADR недели, п. 6.4 и вето compliance: на страницу дня 30 идут только времена
// и коды. Текста ответа модели нет ни в данных, ни в разметке.
test('в данных дня 30 нет ни одного текста ответа модели', () => {
  const d = DATA()
  const seen = []
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (!node || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node)) {
      if (['answer', 'text', 'prompt', 'judge_note', 'answers', 'completion'].includes(k)) seen.push(k)
      walk(v)
    }
  }
  walk(d)
  assert.deepEqual(seen, [], 'в данных есть поля с текстом: ' + seen.join(', '))
})

// I-1, I-3, I-10: страница публичная. Адрес частной сети, имя машины в ней и
// значение ключа в данных и в разметке — дефект, а не недосмотр.
test('ни в данных, ни в разметке дня 30 нет адресов частной сети и имён машин', () => {
  const texts = [read('../site/day30/results.json'), read('../site/day30/index.html'),
    read('../site/day30/app.js')]
  for (const t of texts) {
    assert.ok(!/\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/.test(t),
      'адрес частной сети Tailscale в тексте страницы')
    assert.ok(!/[A-Za-z0-9-]+\.ts\.net/.test(t), 'имя машины в частной сети в тексте страницы')
    assert.ok(!/s[k]-ant-|EVAL_KEY=\S/.test(t), 'похожее на значение ключа в тексте страницы')
  }
})
