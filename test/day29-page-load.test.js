// Страница дня 29 грузит два обычных скрипта в одну глобальную область:
// сначала site/day29/verdict.js, затем site/day29/app.js. Этот тест повторяет
// именно это — vm.Script в общем контексте, нестрогий режим, Annex B
// действует, — а не импорт модуля, как тест вердикта.
//
// Ради чего: у дня 21 голый блок `{ function plural(){} }` в verdict.js
// выпускал функции в глобальную область, и `const { … } = …` в app.js падал с
// SyntaxError — страница вечно «читала результаты» (находка design-review к
// #295). test/day29-verdict.test.js этого не увидит: в Node импорт — модуль,
// Annex B там не действует, а app.js не участвует вовсе. site/ не единица CI,
// и без этого теста падение видно только в браузере.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')

const SCRIPTS = ['../site/day29/verdict.js', '../site/day29/app.js']

function runScripts(ctx) {
  for (const p of SCRIPTS) {
    new vm.Script(read(p), { filename: p.split('/').pop() }).runInContext(ctx)
  }
  return ctx
}

test('verdict.js и app.js дня 29 грузятся в одну область без ошибки', () => {
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

// Подложный DOM: ровно столько, сколько трогает app.js.
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
  const ctx = runScripts(vm.createContext({
    fetch: () => new Promise(() => {}), console, document,
    window: { addEventListener: () => {} },
  }))
  return { ctx, get: (id) => document.getElementById(id) }
}

const DATA = () => JSON.parse(read('../site/day29/results.json'))

// Ради чего: таблица с одними заголовками обещает числа, которых нет. Три
// негодных состояния обязаны оставить на экране причину, а не пустую сетку.
for (const [name, mutate] of [
  ['файла нет или он негоден', () => ({})],
  ['чужой день в файле', () => ({ ...DATA(), day: 28 })],
  ['прогона ещё не было', () => ({ ...DATA(), axes: [] })],
]) {
  test('таблицы не остаются пустыми: ' + name, () => {
    const dom = fakeDom()
    dom.ctx.render(mutate())
    for (const id of ['gain-tbl', 'axes-tbl', 'quant-tbl']) {
      assert.equal(dom.get(id).hidden, true, 'таблица ' + id + ' осталась на экране')
    }
    for (const id of ['axes-status', 'quant-status']) {
      assert.equal(dom.get(id).hidden, false, 'причины на месте блока ' + id + ' нет')
      assert.ok(dom.get(id).textContent.length > 0, 'причина пуста: ' + id)
    }
    assert.equal(dom.get('axes-body').children.length, 0, 'в таблице осей появились строки')
    assert.equal(dom.get('gain-body').children.length, 0, 'в таблице итога появились строки')
    assert.ok(dom.get('verdict').textContent.length > 0, 'вывод пуст')
    assert.equal(dom.get('prompt-before').textContent, 'нет данных',
      'промпт остался строкой загрузки')
  })
}

test('частичный результат: нет «после» — вывод не считается, оси показаны', () => {
  const dom = fakeDom()
  const d = DATA()
  delete d.after
  dom.ctx.render(d)
  assert.match(dom.get('verdict').textContent, /Сравнивать нечего: измерена одна сторона из двух/)
  assert.equal(dom.get('axes-tbl').hidden, false, 'что измерено, страница всё равно показывает')
})

test('оси сжатия в прогоне нет: причина словами, а не пустая таблица', () => {
  const dom = fakeDom()
  const d = DATA()
  delete d.quant
  dom.ctx.render(d)
  assert.equal(dom.get('quant-tbl').hidden, true)
  assert.equal(dom.get('quant-status').hidden, false)
  assert.match(dom.get('quant-status').textContent, /Оси сжатия весов в этом прогоне нет/)
})

test('на полных данных таблицы, правило и подвал показаны', () => {
  const dom = fakeDom()
  const data = DATA()
  dom.ctx.render(data)
  assert.equal(dom.get('axes-tbl').hidden, false)
  assert.equal(dom.get('gain-tbl').hidden, false)
  assert.equal(dom.get('quant-tbl').hidden, false)
  assert.equal(dom.get('axes-body').children.length, data.axes.length, 'строк осей не столько, сколько осей')
  assert.equal(dom.get('quant-body').children.length, 4, 'строк таблицы сжатия не четыре')
  assert.equal(dom.get('rule-list').children.length, data.axes.length,
    'причина входа или невхода названа не у каждой оси')
  assert.match(dom.get('rule-text').textContent, /В «после» не вошла ни одна ось/)
  assert.match(dom.get('changed-line').textContent, /менялась одна ось/)
  assert.match(dom.get('stab-line').textContent, /Повторов в этом прогоне нет/)
  assert.ok(dom.get('run-line').textContent.includes('коммит'), 'строки прогона нет')
  assert.ok(dom.get('run-notes').children.length > 0, 'оговорки прогона не показаны')
  assert.equal(dom.get('limit-repeats').textContent, '1', 'повторы не взяты из данных')
  assert.equal(dom.get('limit-suspect').hidden, false, 'оговорка об испорченных счётчиках скрыта')
  assert.ok(dom.get('prompt-before').textContent.length > 50, 'промпт «до» не показан')
  assert.ok(dom.get('prompt-after').textContent.length > 50, 'промпт «после» не показан')
})

test('index.html дня 29 грузит оба скрипта и не грузит ничего с CDN', () => {
  const html = read('../site/day29/index.html')
  assert.ok(html.includes('src="verdict.js"'), 'verdict.js не подключён')
  assert.ok(html.includes('src="app.js"'), 'app.js не подключён')
  // Сравниваются именно теги: слово «verdict.js» стоит ещё и в комментарии
  // шапки, и по нему проверка проходила бы при любом порядке скриптов.
  assert.ok(html.indexOf('src="verdict.js"') < html.indexOf('src="app.js"'),
    'app.js подключён раньше verdict.js — вердикт в нём будет не определён')
  assert.ok(!/(src|href)="https?:\/\/[^"]*\.(js|css)"/.test(html), 'есть запрос к сторонним скриптам или стилям')
  assert.ok(/<noscript>/.test(html) && /results\.json/.test(html), 'noscript без ссылки на данные')
  assert.ok(!/<details[^>]*\sopen/.test(html), 'раскрывающийся блок стоит open в разметке')
})

// Оговорки дня 29, которые обязаны стоять рядом с числами, а не под details:
// разница не только в сжатии, вердикт по этой оси проверить нельзя, чистой
// оси нет и почему, сборка без отказов в «после» не входит.
test('index.html дня 29 несёт четыре обязательных оговорки оси сжатия на виду', () => {
  const html = read('../site/day29/index.html')
  const body = html.split('<main>')[1].split('</main>')[0]
  const open = body.replace(/<details[\s\S]*?<\/details>/g, '')
  for (const phrase of [
    'не только в сжатии',
    'вердикт по этой оси проверить нельзя',
    'чистого Q6_K у этой модели в библиотеке движка не существует',
    'не входит ни при каких числах',
  ]) {
    assert.ok(open.includes(phrase), 'оговорки «' + phrase + '» нет вне раскрывающихся блоков')
  }
})

// Форма файла данных: страница встаёт в «ошибка» при чужом day, и это ловится
// только здесь — site/ не единица CI, валидатора results.json нет (Р-3).
test('results.json дня 29 несёт свой день, повторы, базу, оси и только числа у сборки без отказов', () => {
  const d = DATA()
  assert.equal(d.day, 29)
  assert.equal(typeof d.repeats, 'number')
  assert.ok(Array.isArray(d.axes) && d.axes.length > 0, 'осей нет')
  for (const a of d.axes) {
    assert.equal(typeof a.name, 'string')
    assert.ok(typeof a.changed === 'number' && a.changed >= 1, 'у оси нет числа изменённых осей')
  }
  assert.ok(d.base && typeof d.base.score_avg === 'number', 'базы в файле нет')
  // Вето ADR 2026-10-07-1349: от стороны без отказов везутся только числа.
  for (const key of ['answer', 'prompt', 'judge_note', 'answers']) {
    assert.ok(!(key in d.quant.b), 'у стороны без отказов в данных есть поле ' + key)
  }
})

// Вывод дня, порог шума, слова колонки «Разница» и перечень осей «после»
// считаются страницей. В данных их нет — иначе файл смог бы сказать
// «локальная не хуже» при числах, говорящих обратное.
test('в results.json дня 29 нет готового вывода, порога шума и слов разницы', () => {
  const d = DATA()
  for (const key of ['verdict', 'verdict_text', 'noise', 'diff_word', 'chosen', 'after_axes']) {
    assert.ok(!(key in d), 'в данных лежит готовый вывод страницы: ' + key)
  }
  assert.ok(!/в пределах шума|цена повтора|не вошла ни одна ось/.test(JSON.stringify(d)),
    'фраза вывода дня приехала из данных, а не посчитана')
})

// I-1, I-3, I-10: страница публичная. Адрес частной сети, имя машины в ней и
// значение ключа в данных и в разметке — дефект, а не недосмотр.
test('ни в данных, ни в разметке дня 29 нет адресов частной сети и имён машин', () => {
  const texts = ['../site/day29/results.json', '../site/day29/index.html',
    '../site/day29/app.js', '../site/day29/verdict.js'].map(read)
  for (const t of texts) {
    assert.ok(!/\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/.test(t),
      'адрес частной сети Tailscale в тексте страницы')
    assert.ok(!/[A-Za-z0-9-]+\.ts\.net/.test(t), 'имя машины в частной сети в тексте страницы')
    assert.ok(!/s[k]-ant-|EVAL_KEY=\S/.test(t), 'похожее на значение ключа в тексте страницы')
  }
})
