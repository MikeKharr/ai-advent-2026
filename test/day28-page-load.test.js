// Страница дня 28 грузит два обычных скрипта в одну глобальную область:
// сначала site/day28/verdict.js, затем site/day28/app.js. Этот тест повторяет
// именно это — vm.Script в общем контексте, нестрогий режим, Annex B
// действует, — а не импорт модуля, как тест вердикта.
//
// Ради чего: у дня 21 голый блок `{ function plural(){} }` в verdict.js
// выпускал функции в глобальную область, и `const { plural } = …` в app.js
// падал с SyntaxError — страница вечно «читала результаты» (находка
// design-review к #295). test/day28-verdict.test.js этого не увидит: в Node
// импорт — модуль, Annex B там не действует, а app.js не участвует вовсе.
// site/ не единица CI, и без этого теста падение видно только в браузере.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')

const SCRIPTS = ['../site/day28/verdict.js', '../site/day28/app.js']

function runScripts(ctx) {
  for (const p of SCRIPTS) {
    new vm.Script(read(p), { filename: p.split('/').pop() }).runInContext(ctx)
  }
  return ctx
}

test('verdict.js и app.js дня 28 грузятся в одну область без ошибки', () => {
  // Минимум окружения: на верхнем уровне app.js объявляет функции, размечает
  // прокручиваемые области и зовёт fetch. fetch не завершается — рендер здесь
  // не проверяется, проверяется загрузка.
  assert.doesNotThrow(() => runScripts(vm.createContext({
    fetch: () => new Promise(() => {}),
    console,
    document: { querySelectorAll: () => [] },
    window: { addEventListener: () => {} },
  })))
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
  const ctx = runScripts(vm.createContext({
    fetch: () => new Promise(() => {}), console, document,
    window: { addEventListener: () => {} },
    location: { hash: '' },
  }))
  return { ctx, get: (id) => document.getElementById(id) }
}

const DATA = () => JSON.parse(read('../site/day28/results.json'))

// Ради чего: таблица с одними заголовками обещает числа, которых нет. Три
// негодных состояния обязаны оставить на экране причину, а не пустую сетку.
for (const [name, mutate] of [
  ['файла нет или он негоден', () => ({})],
  ['чужой день в файле', () => ({ ...DATA(), day: 29 })],
  ['прогона ещё не было', () => ({ ...DATA(), questions: [] })],
]) {
  test('таблицы не остаются пустыми: ' + name, () => {
    const dom = fakeDom()
    dom.ctx.render(mutate())
    for (const id of ['cmp-tbl', 'q-tbl', 'stab-tbl']) {
      assert.equal(dom.get(id).hidden, true, 'таблица ' + id + ' осталась на экране')
    }
    for (const id of ['q-status', 'stab-status', 'bd-status']) {
      assert.equal(dom.get(id).hidden, false, 'причины на месте блока ' + id + ' нет')
      assert.ok(dom.get(id).textContent.length > 0, 'причина пуста: ' + id)
    }
    assert.equal(dom.get('cmp-body').children.length, 0, 'в таблице итога появились строки')
    assert.equal(dom.get('q-body').children.length, 0, 'в таблице вопросов появились строки')
    assert.ok(dom.get('verdict').textContent.length > 0, 'вывод пуст')
  })
}

test('частичный результат: одна сторона из двух — вывод не считается', () => {
  const dom = fakeDom()
  const d = DATA()
  delete d.summary.cloud
  dom.ctx.render(d)
  assert.match(dom.get('verdict').textContent, /Сравнивать нечего: измерена одна сторона из двух/)
  assert.equal(dom.get('q-tbl').hidden, false, 'что измерено, страница всё равно показывает')
})

test('на полных данных таблицы, стабильность и разбор показаны', () => {
  const dom = fakeDom()
  dom.ctx.render(DATA())
  assert.equal(dom.get('cmp-tbl').hidden, false)
  assert.equal(dom.get('q-tbl').hidden, false)
  assert.equal(dom.get('stab-tbl').hidden, false)
  assert.equal(dom.get('q-body').children.length, 10, 'строк вопросов не десять')
  assert.equal(dom.get('stab-body').children.length, 3, 'строк стабильности не три')
  assert.equal(dom.get('breakdown').children.length, 10, 'записей разбора не десять')
  assert.equal(dom.get('bd-status').hidden, true)
  assert.ok(dom.get('run-line').textContent.includes('коммит'), 'строки прогона нет')
  assert.ok(dom.get('run-notes').children.length > 0, 'оговорки прогона не показаны')
  assert.equal(dom.get('limit-repeats').textContent, '1', 'повторы не взяты из данных')
  assert.ok(dom.get('limit-ids').textContent.includes('q72'), 'вопросы стабильности не названы')
})

// Ради чего: оговорки прогона стояли вторым безымянным списком под
// постоянными границами меры, и семь из десяти повторяли уже сказанное
// страницей (находка design-review к #340). Фильтр — названный список, и он
// обязан ошибаться в сторону «показать лишнее», а не «спрятать нужное».
test('оговорки прогона стоят под своей подписью, а повторяющие сказанное сняты', () => {
  const dom = fakeDom()
  dom.ctx.render(DATA())
  assert.equal(dom.get('run-notes-cap').hidden, false, 'подписи у оговорок прогона нет')
  assert.equal(dom.get('run-notes').hidden, false)
  const shown = dom.get('run-notes').children.map((li) => li.textContent)
  assert.ok(shown.length < DATA().notes.length, 'ни одна повторяющая оговорка не снята')
  assert.ok(!shown.some((t) => t.startsWith('Один повтор на вопрос')),
    'оговорка, повторяющая постоянные границы меры, осталась на экране')
  assert.ok(shown.some((t) => t.startsWith('Локальный ответ упёрся в потолок')),
    'снята оговорка про потолок ответа, а она отвечает на «можно ли верить числу»')
  assert.match(dom.get('run-notes-dup').textContent, /^Ещё \d+ оговор/,
    'снятое с экрана не названо числом')
  assert.equal(dom.get('run-notes-dup').hidden, false)
})

test('незнакомая оговорка прогона остаётся на экране', () => {
  const dom = fakeDom()
  const d = DATA()
  d.notes = ['Совершенно новая оговорка, которой страница не знает.']
  dom.ctx.render(d)
  assert.deepEqual(dom.get('run-notes').children.map((li) => li.textContent), d.notes)
  assert.equal(dom.get('run-notes-dup').hidden, true, 'снятым названо то, что не снималось')
})

test('все оговорки повторяют сказанное: список прячется, число остаётся', () => {
  const dom = fakeDom()
  const d = DATA()
  d.notes = d.notes.filter((n) => n.startsWith('Один повтор на вопрос') || n.startsWith('Судья — модель'))
  assert.equal(d.notes.length, 2, 'проверка потеряла смысл: таких оговорок в данных не две')
  dom.ctx.render(d)
  assert.equal(dom.get('run-notes').hidden, true)
  assert.equal(dom.get('run-notes-cap').hidden, true, 'подпись осталась над пустым списком')
  assert.match(dom.get('run-notes-dup').textContent, /Ещё 2 оговорки/)
})

test('index.html дня 28 грузит оба скрипта и не грузит ничего с CDN', () => {
  const html = read('../site/day28/index.html')
  assert.ok(html.includes('src="verdict.js"'), 'verdict.js не подключён')
  assert.ok(html.includes('src="app.js"'), 'app.js не подключён')
  // Сравниваются именно теги: слово «verdict.js» стоит ещё и в комментарии
  // шапки, и по нему проверка проходила бы при любом порядке скриптов.
  assert.ok(html.indexOf('src="verdict.js"') < html.indexOf('src="app.js"'),
    'app.js подключён раньше verdict.js — вердикт в нём будет не определён')
  assert.ok(!/(src|href)="https?:\/\/[^"]*\.(js|css)"/.test(html), 'есть запрос к сторонним скриптам или стилям')
  assert.ok(/<noscript>/.test(html) && /results\.json/.test(html), 'noscript без ссылки на данные')
})

// Форма файла данных: страница встаёт в «ошибка» при чужом day, и это ловится
// только здесь — site/ не единица CI, валидатора results.json нет (Р-3).
test('results.json дня 28 несёт свой день, повторы, обе стороны и три повтора у трёх вопросов', () => {
  const d = DATA()
  assert.equal(d.day, 28)
  assert.equal(typeof d.repeats, 'number')
  assert.ok(Array.isArray(d.questions) && d.questions.length > 0, 'вопросов нет')
  const allowed = new Set(['верно', 'частично', 'неверно'])
  for (const q of d.questions) {
    assert.equal(typeof q.id, 'string')
    assert.ok([true, false, null].includes(q.retrieved_match),
      'недопустимое retrieved_match у ' + q.id)
    for (const side of ['local', 'cloud']) {
      assert.ok(allowed.has(q[side].verdict), 'недопустимый вердикт у ' + q.id + '/' + side)
      assert.ok(q[side].answer.length > 0, 'ответ пуст у ' + q.id + '/' + side)
    }
  }
  const withRuns = d.questions.filter((q) => Array.isArray(q.local.runs) && q.local.runs.length)
  assert.deepEqual(withRuns.map((q) => q.id), d.stability_ids,
    'повторы стоят не у тех вопросов, что названы в stability_ids')
  for (const q of withRuns) assert.equal(q.local.runs.length, 3)
})

// I-1, I-3, I-10: страница публичная. Адрес частной сети, имя машины в ней и
// значение ключа в данных и в разметке — дефект, а не недосмотр.
test('ни в данных, ни в разметке дня 28 нет адресов частной сети и имён машин', () => {
  const texts = ['../site/day28/results.json', '../site/day28/index.html',
    '../site/day28/app.js', '../site/day28/verdict.js'].map(read)
  for (const t of texts) {
    assert.ok(!/\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/.test(t),
      'адрес частной сети Tailscale в тексте страницы')
    assert.ok(!/[A-Za-z0-9-]+\.ts\.net/.test(t), 'имя машины в частной сети в тексте страницы')
    assert.ok(!/s[k]-ant-|EVAL_KEY=\S/.test(t), 'похожее на значение ключа в тексте страницы')
  }
})
